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
import redisHelper from '#services/redis_helper' // Correction: import en tant que default
import { NotificationType } from '#models/notification'
import env from '#start/env'

// --- Configuration ---
const BATCH_SIZE = env.get('AVAILABILITY_SYNC_BATCH_SIZE')
const TOTAL_WORKERS = env.get('AVAILABILITY_SYNC_TOTAL_WORKERS')
const WORKER_ID = env.get('AVAILABILITY_SYNC_WORKER_ID')
const CACHE_TTL_SECONDS = env.get('AVAILABILITY_CACHE_TTL_SECONDS')
const SYNC_INTERVAL_MS = env.get('AVAILABILITY_SYNC_INTERVAL_MS')

export default class AvailabilitySyncWorker extends BaseCommand {
  public static commandName = 'availability:sync-status'
  public static description = 'Synchronizes driver ACTIVE/INACTIVE status based on schedule (single timezone context).'

  private isRunning = true
  private syncTimer: NodeJS.Timeout | null = null

  public static options: CommandOptions = { startApp: true }

  // Ajout d'un constructeur pour appeler registerShutdownHandler si besoin, ou l'appeler dans run.
  // constructor() {
  //   super() // Nécessaire si vous avez un constructeur dans BaseCommand
  //   this.registerShutdownHandler() // Appeler ici ou au début de run()
  // }

  private registerShutdownHandler() {
    const handler = async (signal: string) => {
      if (!this.isRunning) return
      logger.info(`Received ${signal}. Availability Sync Worker #${WORKER_ID} shutting down...`)
      this.isRunning = false
      if (this.syncTimer) {
        clearTimeout(this.syncTimer)
        logger.info(`Worker #${WORKER_ID}: Sync timer cleared.`)
      }
      // Attendre un peu que les opérations en cours (batch) se terminent si possible,
      // mais sans bloquer indéfiniment.
      await new Promise(resolve => setTimeout(resolve, Math.min(SYNC_INTERVAL_MS / 2, 2000)));
      logger.info(`👋 Availability Sync Worker #${WORKER_ID} stopped.`)
      process.exit(0)
    }
    process.on('SIGTERM', () => handler('SIGTERM'))
    process.on('SIGINT', () => handler('SIGINT'))
  }

  async run() {
    logger.info(
      `🚀 Availability Sync Worker #${WORKER_ID}/${TOTAL_WORKERS} starting... Interval: ${SYNC_INTERVAL_MS}ms, Batch: ${BATCH_SIZE}, Cache TTL: ${CACHE_TTL_SECONDS}s`
    )
    this.registerShutdownHandler() // S'assurer qu'il est appelé
    await this.synchronizeAndScheduleNext() // Lance immédiatement le premier cycle
  }

  private async synchronizeAndScheduleNext() {
    if (!this.isRunning) {
      logger.info(`Worker #${WORKER_ID}: Not running, skipping sync cycle.`)
      return
    }
    logger.info(`Worker #${WORKER_ID}: Starting sync cycle...`)
    const cycleStartTime = performance.now()

    try {
      await this.synchronizeDriversPartition()
    } catch (error) {
      // Erreurs au niveau du cycle global (ex: connexion DB perdue pendant la pagination initiale)
      logger.error({ err: error, workerId: WORKER_ID }, '🚨 CRITICAL Error during sync cycle.')
    } finally {
      const cycleEndTime = performance.now()
      logger.info(`Worker #${WORKER_ID}: Sync cycle finished in ${(cycleEndTime - cycleStartTime).toFixed(0)}ms.`)
      if (this.isRunning) {
        this.scheduleNextTimer()
      } else {
        logger.info(`Worker #${WORKER_ID}: Shutdown initiated, not scheduling next sync.`)
      }
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
    let totalDriversProcessedThisCycle = 0
    // `now` est défini une fois par cycle de `synchronizeDriversPartition`
    // Cela garantit que tous les chauffeurs d'un cycle sont évalués par rapport au même "moment présent".
    const now = DateTime.now() // Dans le fuseau horaire du serveur, qui est supposé être le fuseau de référence.
    const partitionStartTime = performance.now()

    logger.info(`Worker #${WORKER_ID}: Synchronizing its partition for time ${now.toISO()}...`)

    while (this.isRunning && hasMorePages) {
      logger.trace(`Worker #${WORKER_ID}: Processing page ${currentPage} for its partition.`)
      const driverBatchQuery = Driver.query()
        .select('id', 'fcm_token') // Sélectionner fcm_token ici pour éviter un find() ultérieur si possible
        .whereRaw('abs(hashtext(id::text)) % ? = ?', [TOTAL_WORKERS, WORKER_ID]) // Assurez-vous que id est bien text pour hashtext
        .orderBy('id') // Important pour une pagination stable

      const driverBatch = await driverBatchQuery.paginate(currentPage, BATCH_SIZE)

      if (!this.isRunning) {
        logger.info(`Worker #${WORKER_ID}: Shutdown initiated during batch processing. Stopping partition sync.`)
        break
      }
      if (driverBatch.length === 0 && currentPage === 1) {
        logger.info(`Worker #${WORKER_ID}: No drivers found in its partition.`)
        break;
      }
      if (driverBatch.length === 0) {
        break; // Fin de la pagination
      }


      const batchProcessingStartTime = performance.now()
      // --- Traitement Parallèle du Lot ---
      const results = await Promise.allSettled(
        driverBatch.map((driverRef) => this.processSingleDriver(driverRef.id, driverRef.fcm_token, now))
      )
      // ------------------------------------
      const batchProcessingEndTime = performance.now()
      logger.trace(
        `Worker #${WORKER_ID}: Batch page ${currentPage} (${driverBatch.length} drivers) processed in ${(batchProcessingEndTime - batchProcessingStartTime).toFixed(0)}ms.`
      )

      totalDriversProcessedThisCycle += driverBatch.length

      const failures = results.filter((r) => r.status === 'rejected')
      if (failures.length > 0) {
        logger.warn( // Changé en warn car ce sont des échecs partiels, le cycle continue.
          `Worker #${WORKER_ID}: ${failures.length}/${driverBatch.length} drivers failed processing on page ${currentPage}. See error logs for details.`
        )
        failures.forEach((f) => logger.error({ err: (f as PromiseRejectedResult).reason, driverIdRelated: "Check previous logs" })) // L'erreur dans processSingleDriver devrait déjà contenir driverId
      }

      currentPage++
      hasMorePages = driverBatch.hasMorePages

      // Petite pause optionnelle entre les batches pour ne pas surcharger la DB/Redis en continu
      // if (this.isRunning && hasMorePages) await new Promise(resolve => setTimeout(resolve, 50));
    } // Fin while hasMorePages

    const partitionEndTime = performance.now()
    logger.info(
      `Worker #${WORKER_ID}: Partition sync finished in ${(partitionEndTime - partitionStartTime).toFixed(0)}ms. Total drivers checked in partition this cycle: ${totalDriversProcessedThisCycle}.`
    )
  } // Fin synchronizeDriversPartition

  /**
   * Traite la synchronisation pour UN SEUL driver.
   * @param driverId
   * @param fcmToken Le token FCM du chauffeur, préchargé.
   * @param now Le moment actuel de référence pour ce cycle de synchronisation.
   */
  async processSingleDriver(driverId: string, fcmToken: string | null, now: DateTime): Promise<void> {
    // Clé de cache: utilise l'heure UTC pour la clé si `now` est converti en UTC par DriverAvailabilityChecker
    // Si DriverAvailabilityChecker utilise `now` tel quel (heure serveur), alors la clé doit refléter cela.
    // En supposant que `DriverAvailabilityChecker` utilise `now.toUTC()` comme vu précédemment:
    const cacheKeyTime = now.toUTC().startOf('minute').toISO() // Pour la cohérence avec le checker
    const cacheKey = `driver_availability:${driverId}:${cacheKeyTime}`

    let shouldBeAvailable: boolean | null = null
    let currentDbStatus: DriverStatus | null = null
    let lastStatusRecord: DriversStatus | null = null
    const logContext = { driverId, timeForCheck: now.toISO(), workerId: WORKER_ID }

    try {
      // 1. Récupérer le dernier statut
      lastStatusRecord = await DriversStatus.query()
        .where('driver_id', driverId)
        .orderBy('changed_at', 'desc')
        .first()
      currentDbStatus = lastStatusRecord?.status ?? DriverStatus.INACTIVE // Default à INACTIVE si aucun log

      // 2. Ignorer si statut non pertinent pour synchro planning (ex: en course, en pause manuelle)
      if (
        [
          DriverStatus.IN_WORK, // En mission
          DriverStatus.OFFERING, // En acceptation de mission
          DriverStatus.ON_BREAK, // En pause déclarée par le chauffeur
          DriverStatus.PENDING, // En attente de validation admin (si ce statut existe et est pertinent)
          // Ajouter d'autres statuts qui ne doivent pas être écrasés par le planning
        ].includes(currentDbStatus)
      ) {
        logger.trace({ ...logContext, currentDbStatus }, `Skipped (status ${currentDbStatus} is actively managed or overrides schedule)`)
        return
      }

      // 3. Vérifier le Cache Redis
      const cachedAvailability = await redis.get(cacheKey)
      if (cachedAvailability !== null) {
        shouldBeAvailable = cachedAvailability === '1'
        logger.trace({ ...logContext, cachedValue: shouldBeAvailable, fromCache: true }, `Cache hit for availability`)
      } else {
        // 4. Cache Miss -> Vérifier le planning via DriverAvailabilityChecker
        logger.trace({ ...logContext }, `Cache miss, checking schedule with DriverAvailabilityChecker...`)
        // `now` est passé tel quel. DriverAvailabilityChecker le convertira en UTC si besoin pour ses comparaisons.
        shouldBeAvailable = await DriverAvailabilityChecker.isAvailableBySchedule(driverId, now)
        await redis.setex(cacheKey, CACHE_TTL_SECONDS, shouldBeAvailable ? '1' : '0')
        logger.trace({ ...logContext, calculatedValue: shouldBeAvailable, cachedNow: true }, `Calculated availability and cached`)
      }

      const targetStatus = shouldBeAvailable ? DriverStatus.ACTIVE : DriverStatus.INACTIVE

      // 5. Mettre à jour en base de données et notifier si le statut a changé
      if (targetStatus !== currentDbStatus) {
        logger.info({ ...logContext, currentDbStatus, newTargetStatus: targetStatus }, `Status requires update`)

        const trx = await db.transaction()
        try {
          await DriversStatus.create(
            {
              id: cuid(), // Laisser la DB générer l'ID si c'est un CUID auto-généré par le modèle/DB
              driver_id: driverId,
              status: targetStatus,
              changed_at: now, // Utiliser le `now` du cycle pour la cohérence
              assignments_in_progress_count: lastStatusRecord?.assignments_in_progress_count ?? 0, // Conserver le compteur
              metadata: { reason: 'schedule_sync' },
            },
            { client: trx }
          )

          await trx.commit()
          logger.info({ ...logContext, updatedToStatus: targetStatus }, `Status updated successfully in DB.`)

          // Envoyer une notification Push si le fcmToken est disponible
          if (fcmToken) {
            const notifTitle = 'Mise à jour de votre disponibilité'
            const notifBody = `Votre statut de disponibilité a été automatiquement mis à jour à : ${targetStatus === DriverStatus.ACTIVE ? 'ACTIF (selon planning)' : 'INACTIF (selon planning)'}.`
            await redisHelper.enqueuePushNotification({
              fcmToken,
              title: notifTitle,
              body: notifBody,
              data: {
                driverId,
                newStatus: targetStatus,
                type: NotificationType.SCHEDULE_REMINDER, // Un type de notif spécifique
                timestamp: now.toISO(),
              },
            })
            logger.info({ ...logContext, fcmTokenProvided: true }, `Notification enqueued for status update.`)
          } else {
            logger.warn({ ...logContext, fcmTokenProvided: false }, `Driver has no FCM token. Status updated but not notified via push.`)
          }

        } catch (dbError) {
          await trx.rollback()
          logger.error({ err: dbError, ...logContext, during: 'db_update_and_notification' }, `DB transaction failed for status update.`)
          throw dbError // Relance pour que Promise.allSettled le marque comme 'rejected'
        }
      } else {
        logger.trace({ ...logContext, currentDbStatus, targetStatus }, `Status already up-to-date. No change needed.`)
      }
    } catch (error) {
      // Ce catch gère les erreurs en dehors de la transaction DB (ex: échec de récupération de lastStatusRecord)
      // ou les erreurs relancées par le catch interne.
      logger.error({ err: error, ...logContext, during: 'process_single_driver_main' }, `Failed to process driver availability.`)
      throw error // Relance pour que Promise.allSettled le marque comme 'rejected'
    }
  } // Fin processSingleDriver

  // `close` n'est pas directement appelé par AdonisJS pour les commandes de longue durée,
  // la gestion se fait via les signaux SIGINT/SIGTERM et `isRunning`.
  // La méthode `gracefulShutdown` est maintenant appelée par `registerShutdownHandler`.
  // public async close() { /* ... */ }

} // Fin Worker