import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import redis from '@adonisjs/redis/services/main' // Ou supprime si pas utilisé pour lire/écrire dans le worker
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db' // Ajout pour transaction si nécessaire
import Order from '#models/order'
import Driver from '#models/driver'
import { OrderStatus } from '#models/order'
import { DriverStatus } from '#models/drivers_status'
import { VehicleStatus } from '#models/driver_vehicle'

// Enum for event types to ensure consistency
type RedisEventType = 'driver_refused' | 'driver_accepted' | 'driver_completed'

type EventData = {
  type?: RedisEventType
  orderId?: string
  refusingDriverId?: string
}

// --- Helpers ---
import redis_helper from '#services/redis_helper'
import { NotificationType } from '#models/notification'

// --- Config ---
const ASSIGNMENT_STREAM_KEY = process.env.REDIS_ASSIGNMENT_STREAM || 'assignment_logic_stream'
const WORKER_POLLING_INTERVAL_MS = Number.parseInt(
  process.env.ASSIGNMENT_WORKER_POLL_INTERVAL_MS || '5000',
  10
)
const OFFER_EXPIRATION_SCAN_INTERVAL_MS = Number.parseInt(
  process.env.ASSIGNMENT_EXPIRATION_SCAN_INTERVAL_MS || '40000',
  10
)
const MAX_ASSIGNMENT_ATTEMPTS = Number.parseInt(process.env.ASSIGNMENT_MAX_ATTEMPTS || '20', 10)
const OFFER_DURATION_SECONDS = Number.parseInt(
  process.env.DRIVER_OFFER_DURATION_SECONDS || '36',
  10
)
const DRIVER_SEARCH_RADIUS_KM = Number.parseInt(process.env.DRIVER_SEARCH_RADIUS_KM || '10', 10)
const MAX_EVENTS_PER_POLL = Number.parseInt(process.env.ASSIGNMENT_WORKER_MAX_EVENTS || '10', 10)

export default class AssignmentWorker extends BaseCommand {
  public static commandName = 'assignment:worker'
  public static description = 'Handles mission (re)assignment logic asynchronously.'

  private lastStreamIdRead: string = '$'
  private expirationScanTimer: NodeJS.Timeout | null = null
  private isRunning = true // Flag pour contrôler la boucle

  public static options: CommandOptions = { startApp: true }

  async run() {
    logger.info(
      `🚀 Assignment Worker démarré. Écoute stream: ${ASSIGNMENT_STREAM_KEY}. Scan expiration toutes les ${OFFER_EXPIRATION_SCAN_INTERVAL_MS}ms.`
    )
    this.scheduleExpirationScan() // Lance le premier scan

    while (this.isRunning) {
      // Utilise le flag pour l'arrêt propre
      try {
        // ---- Lecture du Stream Redis (Optionnel si on se base juste sur le scan) ----
        // Si on utilise Redis pour les refus:
        const streams = await redis.xread(
          'COUNT',
          MAX_EVENTS_PER_POLL,
          'BLOCK',
          WORKER_POLLING_INTERVAL_MS, // Attend max 5s
          'STREAMS',
          ASSIGNMENT_STREAM_KEY,
          this.lastStreamIdRead
        )

        if (streams && streams.length > 0 && streams[0][1].length > 0) {
          const messages = streams[0][1]
          for (const [messageId, fieldsArray] of messages) {
            const messageData: EventData = {}
            for (let i = 0; i < fieldsArray.length; i += 2) {
              // @ts-ignore
              messageData[fieldsArray[i] as keyof EventData] = fieldsArray[i + 1]
            }
            logger.info(`📩 Received message ${messageId}: ${JSON.stringify(messageData)}`)
            await this.processAssignmentEvent(messageData)
            this.lastStreamIdRead = messageId
          }
        } else {
          // logger.trace('No new events from stream.');
        }
        // ---- Fin Lecture Stream ----

        // Ajout d'une petite pause même si pas d'event pour ne pas surcharger CPU
        // Surtout si le BLOCK est très court ou absent
        await new Promise((resolve) => setTimeout(resolve, 500)) // Pause 500ms
      } catch (error) {
        logger.error({ err: error }, '🚨 Erreur dans la boucle Worker. Redémarrage après pause...')
        await new Promise((resolve) => setTimeout(resolve, WORKER_POLLING_INTERVAL_MS * 2)) // Pause longue si erreur Redis/autre
      }
    }
    logger.info('Assignment Worker loop ended.')
  }

  /**
   * Traite un événement reçu du stream Redis (ex: refus).
   */

  async processAssignmentEvent(eventData: EventData) {
    const eventType = eventData.type
    const orderId = eventData.orderId
    if (!orderId) {
      logger.warn({ eventData }, 'Ignoring message without orderId.')
      return
    }

    if (eventType === 'driver_refused') {
      const refusingDriverId = eventData.refusingDriverId
      if (refusingDriverId) {
        logger.info(`Processing refusal for Order ${orderId} by Driver ${refusingDriverId}`)
        // Nettoyer l'offre actuelle AVANT de chercher le suivant est plus sûr
        const cleaned = await this.clearOfferOnOrder(orderId, refusingDriverId) // Vérifie si l'offre était bien pour lui
        if (cleaned) {
          // Si l'offre a été nettoyée (donc le refus était pertinent), cherche le suivant
          await this.findAndOfferNextDriver(orderId, [refusingDriverId])
        }
      } else {
        logger.warn({ eventData }, 'Refusal event without refusingDriverId.')
      }
    } else {
      logger.warn({ eventType, orderId }, 'Unknown event type received.')
    }
  }

  /**
   * Logique de scan des offres expirées.
   */
  async scanForExpiredOffers() {
    logger.debug('Scanning for expired offers...')
    let processedCount = 0
    try {
      const now = DateTime.now()
      // Cherche les commandes qui ont une offre, sont expirées et sont PENDING
      const expiredOrders = await Order.query()
        .whereNotNull('offered_driver_id')
        .whereNotNull('offer_expires_at')
        .where('offer_expires_at', '<', now.toISO())
        .whereHas('status_logs', (logQuery) => {
          // Sélectionne le dernier statut et vérifie qu'il est PENDING
          logQuery
            .whereIn('status', [OrderStatus.PENDING]) // Devrait être PENDING seulement
            .orderBy('changed_at', 'desc')
            .limit(1)
            // Vérifie que la ligne retournée (la plus récente) a bien le statut PENDING
            .where('status', OrderStatus.PENDING)
        })
        .limit(50)

      if (expiredOrders.length > 0) {
        logger.info(`Found ${expiredOrders.length} expired offer(s). Processing...`)
        for (const order of expiredOrders) {
          processedCount++
          const expiredDriverId = order.offered_driver_id
          if (!expiredDriverId) continue // Sécurité

          logger.warn(
            `Offer for Order ${order.id} to Driver ${expiredDriverId} has expired at ${order.offer_expires_at?.toFormat('HH:mm:ss')}.`
          )

          // 1. Nettoyer l'offre expirée (Transaction juste pour ça)
          const trxClean = await db.transaction()
          try {
            order.useTransaction(trxClean) // Important d'utiliser la transaction sur l'objet chargé
            order.offered_driver_id = null
            order.offer_expires_at = null
            await order.save()
            await trxClean.commit()
            logger.info(`Cleaned expired offer for Order ${order.id}.`)

            // 2. Tenter de réassigner immédiatement en excluant celui qui a expiré
            await this.findAndOfferNextDriver(order.id, [expiredDriverId])
          } catch (cleanupError) {
            await trxClean.rollback()
            logger.error(
              { err: cleanupError, orderId: order.id },
              'Failed to clean expired offer, retrying next scan.'
            )
            // On ne relance pas immédiatement la réassignation si le nettoyage échoue.
          }
        }
      } else {
        logger.trace('No expired offers found.')
      }
    } catch (error) {
      logger.error({ err: error }, '🚨 Error during expired offer scan.')
    } finally {
      logger.debug(`Scan finished. Processed ${processedCount} expired offers.`)
      // Replannifie le prochain scan SEULEMENT si le worker tourne encore
      if (this.isRunning) this.scheduleExpirationScan()
    }
  }

  /**
   * Fonction utilitaire pour replannifier le scan.
   */
  scheduleExpirationScan() {
    if (this.expirationScanTimer) clearTimeout(this.expirationScanTimer)
    // Ajoute un délai avant le premier scan au démarrage si souhaité
    this.expirationScanTimer = setTimeout(
      () => this.scanForExpiredOffers(),
      OFFER_EXPIRATION_SCAN_INTERVAL_MS
    )
  }

  /**
   * Trouve le prochain meilleur driver et lui fait une offre.
   * @param attemptCount Nombre actuel de tentatives (initialement 1 par le premier appel)
   */
  async findAndOfferNextDriver(
    orderId: string,
    excludeDriverIds: string[],
    attemptCount: number = 1
  ) {
    logger.info(
      `Attempt #${attemptCount} to find next driver for Order ${orderId}, excluding ${excludeDriverIds.length} drivers: [${excludeDriverIds.join(', ')}]`
    )

    if (attemptCount > MAX_ASSIGNMENT_ATTEMPTS) {
      logger.error(`Max attempts (${MAX_ASSIGNMENT_ATTEMPTS}) reached for Order ${orderId}.`)
      await this.escalateUnassignedOrder(orderId)
      return
    }

    let order: Order | null = null
    const trx = await db.transaction() // Transaction pour MàJ offre + notif? (potentiellement)

    try {
      order = await Order.query({ client: trx })
        .where('id', orderId)
        .preload('pickup_address')
        .preload('packages')
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1))
        .first()

      // Vérifications de sécurité cruciales AVANT de chercher un driver
      if (!order) {
        logger.warn(`Order ${orderId} not found during reassignment attempt.`)
        await trx.rollback()
        return
      }
      if (!order.pickup_address) {
        logger.error(`Order ${orderId} missing pickup address.`)
        await trx.rollback()
        return
      }
      const currentStatus = order.status_logs[0]?.status ?? null
      if (currentStatus !== OrderStatus.PENDING) {
        logger.warn(
          `Order ${orderId} no longer PENDING (Status: ${currentStatus}). Aborting reassignment.`
        )
        await trx.rollback()
        return
      }
      if (order.driver_id) {
        logger.warn(
          `Order ${orderId} already has driver ${order.driver_id}. Aborting reassignment.`
        )
        await trx.rollback()
        return
      }
      if (order.offered_driver_id) {
        logger.warn(
          `Order ${orderId} already has an active offer to ${order.offered_driver_id}. Aborting reassignment.`
        )
        await trx.rollback()
        return
      }

      // --- Calcul infos colis agrégées ---
      const totalWeightG = order.packages.reduce(
        (sum, pkg) => sum + (pkg.dimensions?.weight_g || 0) * (pkg.quantity || 1),
        0
      )
      // TODO: Ajouter calcul volume total et extraire 'frigo_needed', 'vehicule_type_preference' etc.

      const pickupPoint = order.pickup_address.coordinates.coordinates // [lon, lat]

      // --- Recherche du driver ---
      const searchRadiusMeters = DRIVER_SEARCH_RADIUS_KM * 1000
      const nowMinus5Minutes = DateTime.now().minus({ minutes: 5 }).toISO() // Pour localisation récente

      // Utilisation de subquery pour le dernier statut pour plus de performance potentielle
      const availableDrivers = await Driver.query({ client: trx })
        .select('drivers.*')
        .where('latest_status', DriverStatus.ACTIVE)
        .preload('vehicles', (vQuery) => vQuery.where('status', VehicleStatus.ACTIVE))
        .whereNotNull('current_location')
        .where('updated_at', '>', nowMinus5Minutes)
        .whereRaw(
          'ST_DistanceSphere(current_location::geometry, ST_MakePoint(?, ?)::geometry) <= ?',
          [pickupPoint[0], pickupPoint[1], searchRadiusMeters]
        )
        .whereNotIn('drivers.id', excludeDriverIds)
        .exec()
      // --- Filtrage Véhicule POST requête ---
      // Ramène tous les candidats potentiels

      const suitableDriver = availableDrivers.find(
        (driver) =>
          driver.vehicles.length > 0 &&
          driver.vehicles.some((v) => v.max_weight_kg === null || v.max_weight_kg >= totalWeightG) // Autorise si null, sinon vérifie poids
        // TODO: Ajouter ici vérifications volume, frigo, etc.
      )
      // --- Fin filtrage ---

      if (suitableDriver) {
        const selectedDriver = suitableDriver
        const expiresAt = DateTime.now().plus({ seconds: OFFER_DURATION_SECONDS })

        // --- MISE A JOUR ORDER ET NOTIFICATION ---
        order.offered_driver_id = selectedDriver.id
        order.offer_expires_at = expiresAt
        await order.save() // Sauvegarde via trx

        if (selectedDriver.fcm_token) {
          const notifTitle = 'Nouvelle Mission'
          const notifBody = `Course #${orderId.substring(0, 6)} (tentative ${attemptCount})... Rém: ${order.remuneration} EUR. Exp: ${expiresAt.toFormat('HH:mm:ss')}`
          const notifData = {
            order_id: orderId,
            offer_expires_at: expiresAt.toISO(),
            type: NotificationType.NEW_MISSION_OFFER,
          }
          const pushSent = await redis_helper.enqueuePushNotification(
            {
              fcmToken: selectedDriver.fcm_token,
              title: notifTitle,
              body: notifBody,
              data: notifData,
            }
          )

          if (!pushSent) {
            logger.warn(
              `Échec envoi Push à Driver ${selectedDriver.id} pour offre Order ${orderId}. L'offre reste mais peut expirer.`
            )
            // Pas d'annulation immédiate, on laisse l'expiration faire son travail
          } else {
            logger.info(
              `Offre Order ${orderId} envoyée au Driver ${selectedDriver.id} (Tentative ${attemptCount})`
            )
          }
        } else {
          logger.warn(
            `Driver ${selectedDriver.id} trouvé mais sans FCM Token pour Order ${orderId}. Offre active mais non notifiée !`
          )
          // L'offre reste active, le driver pourrait la voir s'il ouvre l'app ?
          // Mais probable expiration sans action.
        }
      } else {
        logger.warn(
          `Aucun driver approprié trouvé pour Order ${orderId} dans la tentative #${attemptCount}.`
        )
        // Pas de mise à jour de l'order, on retentera via scan expiration ou prochain event
        if (attemptCount === MAX_ASSIGNMENT_ATTEMPTS) {
          await this.escalateUnassignedOrder(orderId) // Déjà la dernière tentative
        }
      }

      // Commit la transaction (seulement la mise à jour de l'offre sur Order si driver trouvé)
      await trx.commit()
    } catch (error) {
      if (!trx.isCompleted) await trx.rollback()
      logger.error(
        { err: error, orderId, excluded: excludeDriverIds, attempt: attemptCount },
        `🚨 Erreur critique pendant findAndOfferNextDriver.`
      )
      // Tenter de nettoyer une offre laissée ? Risqué si l'erreur vient d'ailleurs.
      if (order && order.offered_driver_id) {
        /* ... tentative nettoyage ... */
        // const cleaned = await this.clearOfferOnOrder(orderId, order.offered_driver_id)
        // if (cleaned) {
        // Si l'offre a été nettoyée (donc le refus était pertinent), cherche le suivant
        //   await this.findAndOfferNextDriver(orderId, [order.offered_driver_id])
        // }
      }
    }
  }

  /**
   * Gère l'escalade pour une commande non assignable.
   */
  async escalateUnassignedOrder(orderId: string) {
    logger.error(
      `ESCALADE pour Order ${orderId}: Assignation échouée après ${MAX_ASSIGNMENT_ATTEMPTS} tentatives.`
    )
    // --- Options possibles ---
    // 1. Augmenter la rémunération (si modèle économique le permet)

    try {
      const order = await Order.find(orderId)
      if (order && order.status_logs[0].status === OrderStatus.PENDING && !order.driver_id) {
        const currentRem = order.remuneration
        order.remuneration = Math.round(currentRem * 1.15 * 100) / 100 // Augmente de 15%
        await order.save()
        logger.info(
          `Rémunération Order ${orderId} augmentée à ${order.remuneration}. Nouvelles tentatives possibles?`
        )
        // Remettre attemptCount à 0? Ou le laisser échouer pour l'instant ?
      }
    } catch (error) {
      logger.error({ err: error, orderId }, 'Failed to increase remuneration.')
    }

    // 2. Notifier les admins
    try {
      // Code pour envoyer un email/slack/push aux admins
      logger.info(`Notifying admins about unassigned Order ${orderId}. (Simulation)`)
      // const admins = await User.query().where('role', RoleType.ADMIN)...
      // await NotificationHelper.sendAdminAlert(...)
    } catch (error) {
      logger.error({ err: error, orderId }, 'Failed to notify admins.')
    }

    // 3. Optionnel: Marquer comme échoué après X temps total
    /*
         const order = await Order.find(orderId);
         if (order && order.status === OrderStatus.PENDING && !order.driver_id) {
             const timeSinceCreation = DateTime.now().diff(order.created_at, 'minutes').minutes;
              if (timeSinceCreation > 60) { // Si en attente depuis plus d'1h
                 logger.error(`Order ${orderId} pending for over 60 mins. Marking as FAILED.`);
                 await OrderStatusLog.create({ ... status: OrderStatus.FAILED, metadata: { reason: 'no_driver_available' }... });
                 // Mettre à jour order.status n'est pas nécessaire si on utilise le log
              }
         }
        */
  }

  /**
   * Nettoie une offre active pour une commande donnée si elle correspond au driver attendu.
   * Retourne true si l'offre a été nettoyée, false sinon.
   */
  async clearOfferOnOrder(orderId: string, expectedDriverId: string): Promise<boolean> {
    const trx = await db.transaction()
    try {
      const order = await Order.query({ client: trx })
        .where('id', orderId)
        .where('offered_driver_id', expectedDriverId) // Condition importante
        .first()

      if (order) {
        order.offered_driver_id = null
        order.offer_expires_at = null
        await order.save()
        await trx.commit()
        logger.info(`Offer cleared on Order ${orderId} for expected driver ${expectedDriverId}.`)
        return true
      } else {
        logger.warn(
          `Offer clearing attempt for Order ${orderId}, but driver ${expectedDriverId} was not the offered one (or order not found). No change made.`
        )
        await trx.rollback() // Rien à faire
        return false
      }
    } catch (error) {
      await trx.rollback()
      logger.error({ err: error, orderId, expectedDriverId }, 'Error during clearOfferOnOrder.')
      return false // Ne pas relancer la recherche si le nettoyage échoue
    }
  }

  /**
   * Appelé à l'arrêt du worker (ex: SIGTERM)
   */
  public async close() {
    this.isRunning = false // Arrête la boucle principale
    if (this.expirationScanTimer) {
      clearTimeout(this.expirationScanTimer)
      logger.info('Expiration scan timer cleared.')
    }
    // Attendre un peu pour que la boucle en cours se termine ?
    await new Promise((resolve) => setTimeout(resolve, 100))
    logger.info('👋 Assignment Worker stopped.')
  }
} // Fin de la classe AssignmentWorker
// Fin contrôleur Tu devras le lancer en tâche de fond après avoir déployé ton application. Avec pm2, par exemple :
// pm2 start ace --name="assignment-worker" -- assignment:worker
