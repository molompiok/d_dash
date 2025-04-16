// app/commands/availability_sync_worker.ts
import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'
import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import { cuid } from '@adonisjs/core/helpers'
import Driver from '#models/driver'
import DriversStatus, { DriverStatus } from '#models/drivers_status'
import DriverAvailabilityChecker from '#services/driver_availability_checker'
import NotificationWorker from './notification_worker.js'
import { NotificationHelper } from '#services/notification_helper'
import redis_helper from '#services/redis_helper'

// --- Configuration ---
const SYNC_INTERVAL_MS = Number.parseInt(process.env.AVAILABILITY_SYNC_INTERVAL_MS || '20000', 10) // 20s
const BATCH_SIZE = Number.parseInt(process.env.AVAILABILITY_SYNC_BATCH_SIZE || '500', 10) // Lot de 500
const TOTAL_WORKERS = Number.parseInt(process.env.TOTAL_WORKERS || '1', 10) // A définir au lancement !
// WORKER_ID sera injecté par le superviseur (ou lire process.env.NODE_APP_INSTANCE si pm2 cluster)
// Ici on prend 0 par défaut pour exécution manuelle
const WORKER_ID = Number.parseInt(process.env.WORKER_ID || process.env.NODE_APP_INSTANCE || '0', 10)
const CACHE_TTL_SECONDS = Number.parseInt(process.env.AVAILABILITY_CACHE_TTL_SECONDS || '300', 10) // Cache de 5 minutes

export default class AvailabilitySyncWorker extends BaseCommand {
  public static commandName = 'availability:sync-status'
  public static description = 'Synchronizes driver ACTIVE/INACTIVE status based on schedule.'

  private isRunning = true
  private syncTimer: NodeJS.Timeout | null = null

  public static options: CommandOptions = { startApp: true }

  private registerShutdownHandler() {
    process.on('SIGTERM', async () => await this.close())
    process.on('SIGINT', async () => await this.close())
  }

  async run() {
    logger.info(
      `🚀 Availability Sync Worker #${WORKER_ID}/${TOTAL_WORKERS} starting... Interval: ${SYNC_INTERVAL_MS}ms, Batch: ${BATCH_SIZE}, Cache TTL: ${CACHE_TTL_SECONDS}s`
    )
    this.registerShutdownHandler()
    await this.synchronizeAndScheduleNext() // Lance immédiatement
  }

  private async synchronizeAndScheduleNext() {
    if (!this.isRunning) return
    logger.info(`Starting sync cycle (Worker #${WORKER_ID})...`)
    try {
      await this.synchronizeDriversPartition()
    } catch (error) {
      logger.error({ err: error }, '🚨 Error during sync cycle.')
    } finally {
      if (this.isRunning) this.scheduleNextTimer()
    }
  }

  private scheduleNextTimer() {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => this.synchronizeAndScheduleNext(), SYNC_INTERVAL_MS)
    logger.debug(`Worker #${WORKER_ID}: Next sync scheduled in ${SYNC_INTERVAL_MS}ms.`)
  }

  async synchronizeDriversPartition() {
    let currentPage = 1
    let hasMorePages = true
    let driversProcessedThisCycle = 0
    const now = DateTime.now()
    const startTime = performance.now()

    logger.info(`Worker #${WORKER_ID} synchronizing partition for ${now.toISO()}...`)

    while (this.isRunning && hasMorePages) {
      logger.trace(`Worker #${WORKER_ID}: Processing page ${currentPage}`)
      const driverBatch = await Driver.query()
        .select('id') // Sélectionne seulement l'ID pour la pagination
        .whereRaw('id % ? = ?', [TOTAL_WORKERS, WORKER_ID]) // Partitionnement efficace
        .orderBy('id')
        .paginate(currentPage, BATCH_SIZE)

      if (!this.isRunning || driverBatch.length === 0) break

      // --- Traitement Parallèle du Lot ---
      const results = await Promise.allSettled(
        driverBatch.map((driverRef) => this.processSingleDriver(driverRef.id, now)) // Traite chaque driver par ID
      )
      // ------------------------------------

      driversProcessedThisCycle += driverBatch.length

      // Log des échecs partiels s'il y en a
      const failures = results.filter((r) => r.status === 'rejected')
      if (failures.length > 0) {
        logger.error(
          `Worker #${WORKER_ID}: ${failures.length}/${driverBatch.length} drivers failed processing on page ${currentPage}.`
        )
        // Loguer les erreurs spécifiques si besoin (r.reason contient l'erreur)
        failures.forEach((f) => logger.error({ err: (f as PromiseRejectedResult).reason }))
      }

      currentPage++
      hasMorePages = driverBatch.hasMorePages
      if (!hasMorePages) {
        const endTime = performance.now()
        logger.info(
          `Worker #${WORKER_ID} partition sync finished in ${(endTime - startTime).toFixed(0)}ms. Total drivers checked this cycle: ${driversProcessedThisCycle}.`
        )
      }
      // Petite pause après chaque batch pour laisser respirer ? Optionnel
      // await sleep(50);
    } // Fin while hasMorePages
  } // Fin synchronizeDriversPartition

  /**
   * Traite la synchronisation pour UN SEUL driver.
   */
  async processSingleDriver(driverId: string, now: DateTime): Promise<void> {
    const cacheKey = `driver_availability:${driverId}:${now.startOf('minute').toISO()}` // Clé cache plus précise
    let shouldBeAvailable: boolean | null = null
    let currentDbStatus: DriverStatus | null = null
    let lastStatusRecord: DriversStatus | null = null
    const logContext = { driverId, time: now.toISO() }

    try {
      // 1. Récupérer le dernier statut SANS preload (optimisation)
      lastStatusRecord = await DriversStatus.query()
        .where('driver_id', driverId)
        .orderBy('changed_at', 'desc')
        .first()
      currentDbStatus = lastStatusRecord?.status ?? DriverStatus.INACTIVE

      // 2. Ignorer si statut non pertinent pour synchro planning
      if (
        [DriverStatus.IN_WORK, DriverStatus.ON_BREAK, DriverStatus.PENDING].includes(
          currentDbStatus
        )
      ) {
        logger.trace({ ...logContext, currentDbStatus }, `Skipped (status managed elsewhere)`)
        return
      }

      // 3. Vérifier le Cache Redis
      const cached = await redis.get(cacheKey)
      if (cached !== null) {
        shouldBeAvailable = cached === '1'
        logger.trace({ ...logContext, cacheValue: cached, fromCache: true }, `Cache hit`)
      } else {
        // 4. Cache Miss -> Vérifier le planning (appel DB/Checker)
        logger.trace({ ...logContext }, `Cache miss, checking schedule...`)
        shouldBeAvailable = await DriverAvailabilityChecker.isAvailableBySchedule(driverId, now)
        // Stocker dans le cache
        await redis.setex(cacheKey, CACHE_TTL_SECONDS, shouldBeAvailable ? '1' : '0')
      }

      const targetStatus = shouldBeAvailable ? DriverStatus.ACTIVE : DriverStatus.INACTIVE

      // 5. Mettre à jour si nécessaire
      if (targetStatus !== currentDbStatus) {
        logger.info({ ...logContext, currentDbStatus, targetStatus }, `Status requires update`)
        // Transaction juste pour l'écriture du nouveau statut
        const trx = await db.transaction()
        try {
          await DriversStatus.create(
            {
              id: cuid(),
              driver_id: driverId,
              status: targetStatus,
              changed_at: now,
              assignments_in_progress_count: lastStatusRecord?.assignments_in_progress_count ?? 0,
              metadata: { reason: 'schedule_sync' },
            },
            { client: trx }
          )
          await redis_helper.enqueuePushNotification(
            driverId,
            'Status de disponibilité mis à jour',
            `Votre statut de disponibilité a été mis à jour à ${targetStatus === DriverStatus.ACTIVE ? 'ACTIF' : 'INACTIF'}`,
            { driverId, status: targetStatus }
          )
          await trx.commit()
          logger.info({ ...logContext, targetStatus }, `Status updated successfully`)
        } catch (dbError) {
          await trx.rollback()
          throw dbError // Relance pour le catch externe de Promise.allSettled
        }
      } else {
        logger.trace({ ...logContext, currentDbStatus }, `Status already up-to-date`)
      }
    } catch (error) {
      logger.error({ err: error, ...logContext }, `Failed to process driver availability`)
      // Relancer pour que Promise.allSettled le marque comme 'rejected'
      throw error
    }
  } // Fin processSingleDriver

  async close() {
    this.isRunning = false
    if (this.syncTimer) clearTimeout(this.syncTimer)
    logger.info(`👋 Stopping Availability Sync Worker #${WORKER_ID}...`)
    // Attendre la fin du cycle peut être trop long, on préfère arrêter ici
  }
} // Fin Worker
