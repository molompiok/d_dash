// app/commands/assignment_worker.ts
import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import redis from '@adonisjs/redis/services/main'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import Order from '#models/order'
import Driver from '#models/driver'
import { OrderStatus } from '#models/order' // Assurez-vous que OrderStatus est bien défini
import DriversStatus, { DriverStatus } from '#models/drivers_status'
import { VehicleStatus } from '#models/driver_vehicle'

// --- Helpers et Types de RedisHelper ---
import redisHelper, {
  MissionLifecycleEvent,
  type MissionEventData, // Type de base
  type OfferRefusedData,
  type OfferAcceptedData,
  type OfferExpiredData,
  type MissionCompletedData,
  type MissionCancelledData,
  type MissionFailedData,
  type NewOrderReadyForAssignmentData,
  RawInitialAssignmentDetails,
  // type MissionManuallyAssignedData, // Assurez-vous de l'exporter depuis RedisHelper
} from '#services/redis_helper' // Correction: import en tant que default
import { NotificationType } from '#models/notification' // Si toujours utilisé directement ici
import env from '#start/env'
import { cuid } from '@adonisjs/core/helpers'
import OrderStatusLog from '#models/order_status_log'
import redis_helper from '#services/redis_helper'

// --- Configuration ---
const ASSIGNMENT_EVENTS_STREAM_KEY = env.get(
  'REDIS_ASSIGNMENT_LOGIC_STREAM', // Garder le nom de la variable d'env
  'assignment_events_stream' // Valeur par défaut mise à jour
)
const WORKER_POLLING_INTERVAL_MS = env.get('WORKER_POLLING_INTERVAL_MS')
const OFFER_EXPIRATION_SCAN_INTERVAL_MS = env.get('OFFER_EXPIRATION_SCAN_INTERVAL_MS')
const MAX_ASSIGNMENT_ATTEMPTS = env.get('MAX_ASSIGNMENT_ATTEMPTS')
const OFFER_DURATION_SECONDS = env.get('DRIVER_OFFER_DURATION_SECONDS')
const DRIVER_SEARCH_RADIUS_KM = env.get('DRIVER_SEARCH_RADIUS_KM')
const MAX_EVENTS_PER_POLL = env.get('MAX_EVENTS_PER_POLL')

// Type pour les messages parsés du stream Redis
// On s'attend à ce que les champs correspondent aux propriétés de nos interfaces MissionEventData
type ParsedRedisMessage = Record<string, string>


export default class AssignmentWorker extends BaseCommand {
  public static commandName = 'assignment:worker'
  public static description = 'Handles mission (re)assignment logic based on mission lifecycle events.'

  private lastStreamIdRead: string = '$' // Commence à lire les nouveaux messages après le démarrage
  private expirationScanTimer: NodeJS.Timeout | null = null
  private isRunning = true

  public static options: CommandOptions = { startApp: true }

  async run() {
    logger.info(
      `🚀 Assignment Worker démarré. Écoute stream: ${ASSIGNMENT_EVENTS_STREAM_KEY}. Scan expiration toutes les ${OFFER_EXPIRATION_SCAN_INTERVAL_MS}ms.`
    )
    this.scheduleExpirationScan()

    // Enregistrer les gestionnaires d'arrêt
    process.on('SIGINT', () => this.gracefulShutdown('SIGINT'))
    process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'))

    while (this.isRunning) {
      try {
        const streams = await redis.xread(
          'COUNT',
          MAX_EVENTS_PER_POLL,
          'BLOCK',
          WORKER_POLLING_INTERVAL_MS,
          'STREAMS',
          ASSIGNMENT_EVENTS_STREAM_KEY,
          this.lastStreamIdRead
        )

        if (streams && streams.length > 0 && streams[0][1].length > 0) {
          logger.info(`Received streams ${streams} events from stream.`)
          const messages = streams[0][1] // messages = [ [messageId, fieldsArray], ... ]
          for (const [messageId, fieldsArray] of messages) {
            if (!this.isRunning) break

            const parsedMessage: ParsedRedisMessage = {}
            for (let i = 0; i < fieldsArray.length; i += 2) {
              parsedMessage[fieldsArray[i]] = fieldsArray[i + 1]
            }

            const eventDataForProcessing: MissionEventData = {
              type: parsedMessage.type as MissionLifecycleEvent,
              orderId: parsedMessage.orderId,
              driverId: parsedMessage.driverId,
              timestamp: parsedMessage.timestamp ? parseInt(parsedMessage.timestamp, 10) : Date.now(),
              // Copier les autres champs... et parser initialAssignmentDetails
            };

            if (parsedMessage.type === MissionLifecycleEvent.NEW_ORDER_READY_FOR_ASSIGNMENT && parsedMessage.initialAssignmentDetails) {
              try {
                // Le cast est pour informer TypeScript de la structure attendue après parsing
                (eventDataForProcessing as NewOrderReadyForAssignmentData).initialAssignmentDetails_parsed = JSON.parse(parsedMessage.initialAssignmentDetails) as RawInitialAssignmentDetails;
              } catch (e) {
                logger.warn({ messageId, orderId: parsedMessage.orderId, err: e },
                  "Failed to parse initialAssignmentDetails JSON string from event.");
              }
            }
            // Copier les autres champs spécifiques si nécessaire ou les laisser pour un cast plus tardif

            logger.info({ messageId, stream: ASSIGNMENT_EVENTS_STREAM_KEY, data: parsedMessage }, `📩 Received message`);
            await this.processAssignmentEvent(eventDataForProcessing, messageId); // Passer l'objet partiellement transformé
            this.lastStreamIdRead = messageId;
          }
        } else {
          // logger.trace('No new events from stream.')
        }
        // Petite pause pour éviter de surcharger le CPU si BLOCK est court ou s'il n'y a pas de BLOCK
        if (this.isRunning) await new Promise((resolve) => setTimeout(resolve, 200))

      } catch (error) {
        logger.error({ err: error }, '🚨 Erreur dans la boucle principale du Worker. Redémarrage après pause...')
        if (this.isRunning) await new Promise((resolve) => setTimeout(resolve, WORKER_POLLING_INTERVAL_MS * 2))
      }
    }
    logger.info('Assignment Worker loop ended.')
  }

  /**
   * Helper pour remettre un driver au statut ACTIVE après qu'une offre
   * pour lui a été résolue (expirée, refusée, commande annulée).
   * @param driverId L'ID du driver.
   * @param orderId L'ID de la commande pour laquelle l'offre était.
   * @param reason La raison du changement de statut (pour metadata).
   * @param trx La transaction de base de données optionnelle.
   */
  private async revertDriverToActiveStatus(
    driverId: string,
    orderId: string, // Pour le contexte dans les logs/metadata
    reason: string,
    trx?: any// Optionnel si l'appelant gère déjà une transaction
  ): Promise<boolean> {
    const currentDriverStatusRecord = await DriversStatus.query({ client: trx }) // Utiliser la transaction si fournie
      .where('driver_id', driverId)
      .orderBy('changed_at', 'desc')
      .first();

    if (currentDriverStatusRecord && currentDriverStatusRecord.status === DriverStatus.OFFERING) {
      // Vérification supplémentaire (optionnelle mais bonne) :
      // S'assurer que l'offre actuelle de la commande (si elle existe encore) était bien pour ce driver.
      // Cela évite de changer le statut si une autre offre a été faite à ce driver entre-temps pour une autre commande.
      // Pour une logique plus simple, on peut juste vérifier si son statut est OFFERING.
      const orderCheck = await Order.find(orderId, { client: trx });
      if (orderCheck && orderCheck.offered_driver_id !== driverId && orderCheck.offered_driver_id !== null) {
        logger.warn({ driverId, orderId, currentOffered: orderCheck.offered_driver_id, reason },
          `Driver ${driverId} is OFFERING, but order ${orderId} is now offered to someone else or not offered. Status not reverted by this event.`);
        return false;
      }

      const driver = await Driver.find(driverId, { client: trx });
      if (!driver) {
        logger.warn({ driverId, orderId, reason }, `Driver ${driverId} not found when trying to revert status after offer for ${orderId} ended.`);
        return false;
      }


      logger.info({ driverId, orderId, reason }, `Reverting driver ${driverId} status to ACTIVE because offer for order ${orderId} ended due to: ${reason}.`);

      await DriversStatus.create(
        {
          id: cuid(), // Si vous générez les IDs ainsi
          driver_id: driverId,
          status: DriverStatus.ACTIVE, // Le remettre en état de recevoir des offres
          changed_at: DateTime.now(),
          assignments_in_progress_count: currentDriverStatusRecord.assignments_in_progress_count, // Conserver le compte
          metadata: { reason: `offer_ended_for_order_${orderId} - ${reason}` },
        },
        { client: trx } // Utiliser la transaction si fournie
      );
      if (driver.fcm_token)
        redis_helper.enqueuePushNotification({
          fcmToken: driver.fcm_token,
          title: 'Votre offre a expiré',
          body: `Votre offre pour la course ${orderId} a expiré.`,
          data: {
            newStatus: DriverStatus.ACTIVE, type: NotificationType.SCHEDULE_REMINDER, timestamp: DateTime.now().toISO()
          },
        })
      // Mettre à jour le champ dénormalisé sur le modèle Driver si vous en avez un
      await Driver.query({ client: trx }).where('id', driverId).update({ latest_status: DriverStatus.ACTIVE });
      return true;
    } else if (currentDriverStatusRecord) {
      logger.warn({ driverId, orderId, currentStatus: currentDriverStatusRecord.status, reason },
        `Driver ${driverId} status is ${currentDriverStatusRecord.status}, not OFFERING as expected when offer for ${orderId} ended. Status not reverted by this event.`);
    } else {
      logger.warn({ driverId, orderId, reason },
        `No status record found for driver ${driverId} when trying to revert status after offer for ${orderId} ended.`);
    }
    return false;
  }

  /**
   * Traite un événement reçu du stream Redis.
   */
  async processAssignmentEvent(eventData: MissionEventData, messageId: string) {
    const { type, orderId } = eventData
    if (!orderId) {
      logger.warn({ eventData, messageId }, 'Ignoring message without orderId.')
      return
    }
    if (!type) {
      logger.warn({ eventData, messageId }, 'Ignoring message without type.')
      return
    }

    logger.info({ eventType: type, orderId, messageId }, `Processing event`)

    // Utilisation d'un switch pour gérer les différents types d'événements
    switch (type) {

      case MissionLifecycleEvent.NEW_ORDER_READY_FOR_ASSIGNMENT:
        await this.handleNewOrderReady(eventData as NewOrderReadyForAssignmentData & { initialAssignmentDetails_parsed?: RawInitialAssignmentDetails });
        break;

      case MissionLifecycleEvent.OFFER_REFUSED_BY_DRIVER:
        await this.handleOfferRefused(eventData as OfferRefusedData)
        break

      case MissionLifecycleEvent.OFFER_EXPIRED_FOR_DRIVER:
        await this.handleOfferExpired(eventData as OfferExpiredData)
        break

      case MissionLifecycleEvent.OFFER_ACCEPTED_BY_DRIVER:
        await this.handleOfferAccepted(eventData as OfferAcceptedData)
        break

      case MissionLifecycleEvent.MANUALLY_ASSIGNED:
        // Dans RedisHelper, MissionManuallyAssignedData n'était pas exportée explicitement.
        // On va la typer ici directement si besoin, ou s'assurer qu'elle est exportée.
        // Pour l'instant, on caste vers un type ad-hoc ou on utilise MissionEventData.
        await this.handleManuallyAssigned(eventData as MissionEventData & { driverId: string; assignedByAdminId: string })
        break

      case MissionLifecycleEvent.COMPLETED:
      case MissionLifecycleEvent.CANCELLED_BY_ADMIN:
      case MissionLifecycleEvent.CANCELLED_BY_SYSTEM:
      case MissionLifecycleEvent.FAILED:
        // Ces événements signalent une fin de vie pour la recherche d'assignation.
        // On pourrait vouloir s'assurer que l'offre est nettoyée si elle était active.
        await this.handleOrderTerminalState(eventData as (MissionCompletedData | MissionCancelledData | MissionFailedData))
        break

      default:
        logger.warn({ eventType: type, orderId, messageId }, 'Unknown or unhandled event type received.')
    }
  }

  // --- Gestionnaires d'événements spécifiques ---

  private async handleOfferRefused(event: OfferRefusedData) {
    const { orderId, driverId: refusingDriverId, reason } = event;
    logger.info(`Driver ${refusingDriverId} REFUSED Order ${orderId}. Reason: ${reason || 'N/A'}`);

    const trx = await db.transaction(); // Démarrer une transaction pour les opérations atomiques
    try {
      const offerCleaned = await this.clearCurrentOffer(orderId, refusingDriverId, false, trx); // Passer la transaction
      if (offerCleaned) {
        await this.revertDriverToActiveStatus(refusingDriverId, orderId, 'offer_refused', trx); // Passer la transaction
        await trx.commit(); // Valider les changements (nettoyage offre + statut driver)
        // Maintenant, chercher le prochain driver hors de la transaction, car cela peut prendre du temps
        await this.findAndOfferNextDriver(orderId, [refusingDriverId]);
      } else {
        logger.warn(
          { orderId, refusingDriverId },
          `Refusal received from driver ${refusingDriverId} for order ${orderId}, but they were not the one with the current offer or no offer to clear. No status change or reassignment triggered by this specific event instance.`
        );
        await trx.rollback(); // Annuler si rien n'a été fait au niveau de l'offre
      }
    } catch (error) {
      await trx.rollback();
      logger.error({ err: error, orderId, refusingDriverId }, 'Error in handleOfferRefused transaction.');
    }
  }

  private async handleOfferExpired(event: OfferExpiredData) {
    const { orderId, driverId: expiredDriverId } = event;
    logger.warn(`Offer EXPIRED for Driver ${expiredDriverId} on Order ${orderId}.`);

    const trx = await db.transaction();
    try {
      const offerCleaned = await this.clearCurrentOffer(orderId, expiredDriverId, false, trx);
      if (offerCleaned) {
        await this.revertDriverToActiveStatus(expiredDriverId, orderId, 'offer_expired_event', trx);
        await trx.commit();
        await this.findAndOfferNextDriver(orderId, [expiredDriverId]);
      } else {
        logger.warn(
          { orderId, expiredDriverId },
          `Expiration event for driver ${expiredDriverId}, order ${orderId}, but no active offer was cleared for them. No status change or reassignment triggered by this specific event instance.`
        );
        await trx.rollback();
      }
    } catch (error) {
      await trx.rollback();
      logger.error({ err: error, orderId, expiredDriverId }, 'Error in handleOfferExpired transaction.');
    }
  }

  private async handleNewOrderReady(event: NewOrderReadyForAssignmentData) {
    const { orderId, initialAssignmentDetails_parsed } = event; // Utiliser le champ parsé
    logger.info({ orderId, details: initialAssignmentDetails_parsed }, `New order ${orderId} is ready for assignment. Initiating driver search.`);

    // Vérifier si la commande n'est pas déjà assignée ou offerte (sécurité, peu probable si l'event est juste après création)
    const order = await Order.query()
      .where('id', orderId)
      .preload('status_logs', (query) => { // <--- AJOUTER LE PRELOAD
        query.orderBy('changed_at', 'desc').limit(1) // Charger seulement le plus récent
      })
      .first();
    if (!order) {
      logger.warn({ orderId }, `Order ${orderId} for NEW_ORDER_READY event not found. Skipping assignment.`);
      return;
    }
    if (order.driver_id || order.offered_driver_id) {
      logger.warn({ orderId, driverId: order.driver_id, offeredDriverId: order.offered_driver_id },
        `Order ${orderId} for NEW_ORDER_READY event is already assigned or has an offer. Skipping initial assignment attempt from event.`
      );
      return;
    }
    logger.info({ orderId, status: order.status_logs }, `Order ${orderId} for NEW_ORDER_READY event is PENDING. Proceeding with initial assignment.`);
    if (order.status_logs[0]?.status !== OrderStatus.PENDING) {
      logger.warn({ orderId, status: order.status_logs[0]?.status },
        `Order ${orderId} for NEW_ORDER_READY event is not PENDING. Skipping initial assignment.`
      );
      return;
    }


    // Lancer la première tentative de recherche de chauffeur.
    // Le '1' pour attemptCount est géré à l'intérieur de findAndOfferNextDriver maintenant
    // basé sur order.assignment_attempt_count.
    // `initialAssignmentDetails` n'est pas directement utilisé par findAndOfferNextDriver dans sa signature actuelle,
    // mais la logique interne de findAndOfferNextDriver récupère ces infos de la DB.
    // Si on voulait l'optimiser, findAndOfferNextDriver pourrait accepter ces détails.
    await this.findAndOfferNextDriver(orderId, []); // Pas d'exclusions initiales, attemptCount géré par la fonction
  }

  private async handleOfferAccepted(event: OfferAcceptedData) {
    const { orderId, driverId } = event
    logger.info(`Driver ${driverId} ACCEPTED Order ${orderId}. Finalizing assignment.`)

    // L'action principale ici est de s'assurer que la commande est bien marquée comme assignée
    // et que toute recherche ultérieure est stoppée.
    // Normalement, le service qui a reçu l'acceptation du chauffeur (ex: API) devrait mettre à jour
    // la commande (order.driver_id, order.status = ASSIGNED, etc.)
    // Le rôle du worker ici est de:
    // 1. Nettoyer `offered_driver_id` et `offer_expires_at` car l'offre est consommée.
    // 2. S'assurer qu'aucune nouvelle offre n'est faite pour cette commande.

    const trx = await db.transaction()
    try {
      const order = await Order.query({ client: trx }).where('id', orderId).first()
      if (!order) {
        logger.warn(`Order ${orderId} not found during acceptance processing.`)
        await trx.rollback()
        return
      }

      // Vérifier si l'acceptation correspond à l'offre active
      if (order.offered_driver_id !== driverId) {
        logger.error(
          { orderId, offered: order.offered_driver_id, acceptedBy: driverId },
          "CRITICAL: Offer accepted by a driver who wasn't the one offered! Investigate."
        )
        // Que faire ici ? C'est une situation anormale.
        // On pourrait ne rien faire, ou nettoyer l'offre si elle était pour `driverId` par erreur.
        // Pour l'instant, on logue et on ne change rien pour éviter d'aggraver.
        await trx.rollback()
        return
      }

      // Si l'API a déjà mis à jour driver_id et statut, c'est bien.
      // Le worker nettoie les champs d'offre.
      order.offered_driver_id = null
      order.offer_expires_at = null
      // Potentiellement, si l'API ne le fait pas, le worker pourrait aussi mettre à jour order.driver_id ici.
      // Mais il est préférable que le point d'entrée de l'acceptation (API) soit responsable de la mise à jour principale.
      // order.driver_id = driverId; // Si nécessaire
      // await OrderStatusLog.create({ orderId, status: OrderStatus.ASSIGNED, driverId }, { client: trx }); // Si nécessaire
      await order.save()
      await trx.commit()
      logger.info(`Offer fields cleaned for Order ${orderId} after acceptance by ${driverId}.`)

      // Aucune nouvelle recherche de chauffeur n'est nécessaire.
    } catch (error) {
      await trx.rollback()
      logger.error({ err: error, orderId, driverId }, `Error processing offer acceptance.`)
    }
  }

  private async handleManuallyAssigned(event: MissionEventData & { driverId: string; assignedByAdminId: string }) {
    const { orderId, driverId, assignedByAdminId } = event
    logger.info(`Order ${orderId} MANUALLY ASSIGNED to Driver ${driverId} by Admin ${assignedByAdminId}.`)

    // Similaire à l'acceptation, on s'assure que les champs d'offre sont nettoyés.
    // L'admin aura probablement déjà mis à jour `order.driver_id` et le statut.
    const trx = await db.transaction()
    try {
      const order = await Order.query({ client: trx }).where('id', orderId).first()
      if (order) {
        if (order.offered_driver_id && order.offered_driver_id !== driverId) {
          logger.warn({ orderId, offered: order.offered_driver_id, manualAssignTo: driverId },
            `Order ${orderId} was manually assigned to ${driverId} but had an active offer for ${order.offered_driver_id}. Cleaning offer.`
          )
          // On pourrait vouloir notifier le driver qui avait l'offre que celle-ci est annulée.
        }
        order.offered_driver_id = null
        order.offer_expires_at = null
        // order.driver_id = driverId; // Devrait être fait par l'action admin
        await order.save()
        await trx.commit()
        logger.info(`Offer fields cleaned for Order ${orderId} after manual assignment.`)
      } else {
        await trx.rollback()
        logger.warn(`Order ${orderId} not found during manual assignment event processing.`)
      }
    } catch (error) {
      await trx.rollback()
      logger.error({ err: error, orderId, driverId }, `Error processing manual assignment.`)
    }
  }

  private async handleOrderTerminalState(event: (MissionCompletedData | MissionCancelledData | MissionFailedData)) {
    const { orderId, type } = event;
    logger.info(`Order ${orderId} reached terminal state: ${type}. Ensuring no active offers persist.`);

    const trx = await db.transaction();
    try {
      // On récupère l'order pour savoir s'il y avait une offre active et pour qui
      const order = await Order.query({ client: trx }).where('id', orderId).first();
      let driverToRevert: string | null = null;

      if (order && order.offered_driver_id) {
        driverToRevert = order.offered_driver_id;
        const { cleaned } = await this.clearCurrentOffer(orderId, driverToRevert, true, trx); // forceClear = true
        if (!cleaned) {
          // Devrait être rare ici si on a trouvé un offered_driver_id
          logger.warn({ orderId, driverToRevert }, "Terminal state: Offer was present but clearCurrentOffer reported no change.");
        }
      }

      if (driverToRevert) {
        await this.revertDriverToActiveStatus(driverToRevert, orderId, `order_terminal_state_${type}`, trx);
      }

      await trx.commit();
      if (driverToRevert) {
        logger.info({ orderId, driverId: driverToRevert, terminalEventType: type }, `Cleaned active offer and reverted driver status due to terminal state event.`);
      } else {
        logger.info({ orderId, terminalEventType: type }, `No active offer to clean or driver to revert for terminal state event.`);
      }

    } catch (error) {
      await trx.rollback();
      logger.error({ err: error, orderId, type }, `Error processing terminal state for order.`);
    }
  }

  /**
   * Scanne les offres expirées en base de données.
   */
  async scanForExpiredOffers() {
    if (!this.isRunning) return
    logger.debug('Scanning for expired offers in database...')
    let processedCount = 0
    try {
      const now = DateTime.now()
      const expiredOrders = await Order.query()
        .whereNotNull('offered_driver_id')
        .whereNotNull('offer_expires_at')
        .where('offer_expires_at', '<', now.toISO())
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1)) // Pour vérifier statut PENDING
        .limit(50) // Limite pour ne pas surcharger

      for (const order of expiredOrders) {
        if (!this.isRunning) break
        processedCount++

        const currentStatus = order.status_logs[0]?.status
        if (currentStatus !== OrderStatus.PENDING || order.driver_id) {
          logger.warn(
            { orderId: order.id, status: currentStatus, driverId: order.driver_id, offeredDriver: order.offered_driver_id },
            `Skipping expired offer scan for non-PENDING or already assigned order.`
          )
          // Nettoyer l'offre quand même si elle est expirée et que la commande n'est plus PENDING ?
          // Probablement une bonne idée pour la cohérence des données.
          if (order.offered_driver_id) {
            await this.clearCurrentOffer(order.id, order.offered_driver_id, true); // forceClear = true
          }
          continue
        }

        const expiredDriverId = order.offered_driver_id! // Not null car vérifié dans la query
        logger.warn(
          `DB Scan: Offer for Order ${order.id} to Driver ${expiredDriverId} has expired at ${order.offer_expires_at?.toFormat('HH:mm:ss')}.`
        )

        // Publier un événement d'expiration.
        // Le worker lui-même consommera cet événement via processAssignmentEvent -> handleOfferExpired.
        // Cela centralise la logique de réassignation.
        await redisHelper.publishMissionOfferExpired(order.id, expiredDriverId)
        // La logique de nettoyage de l'offre et de recherche du prochain driver
        // sera gérée par handleOfferExpired.
      }
      if (processedCount > 0) {
        logger.info(`DB Scan: Found and processed ${processedCount} expired offer(s) by publishing expiration events.`)
      } else {
        logger.trace('DB Scan: No expired offers found needing processing.')
      }

    } catch (error) {
      logger.error({ err: error }, '🚨 Error during expired offer scan.')
    } finally {
      if (this.isRunning) this.scheduleExpirationScan()
    }
  }

  scheduleExpirationScan() {
    if (this.expirationScanTimer) clearTimeout(this.expirationScanTimer)
    this.expirationScanTimer = setTimeout(
      () => this.scanForExpiredOffers(),
      OFFER_EXPIRATION_SCAN_INTERVAL_MS
    )
  }

  /**
   * Trouve le prochain meilleur driver et lui fait une offre.
   * @param orderId
   * @param excludeDriverIds Liste des IDs de chauffeurs à exclure de cette tentative.
   * @param attemptCount_ Nombre de tentatives déjà effectuées pour cette *séquence* de recherche.
   */
  async findAndOfferNextDriver(
    orderId: string,
    excludeDriverIds: string[] = [],
    attemptCount_?: number // Renommé pour éviter conflit avec un potentiel champ 'attemptCount' sur Order
  ) {

    logger.info(`Attempting to find next driver for Order ${orderId}, excluding ${excludeDriverIds.length} drivers: [${excludeDriverIds.join(', ')}]`)
    // Récupérer la commande pour obtenir le nombre de tentatives global et autres détails
    const orderForAttempts = await Order.find(orderId)
    if (!orderForAttempts) {
      logger.warn(`Order ${orderId} not found before attempting to find next driver. Aborting offer.`)
      return
    }
    // Utiliser un champ sur la commande pour le nombre total de tentatives d'assignation
    // ou un mécanisme externe si on ne veut pas surcharger le modèle Order.
    // Pour cet exemple, on simule avec une variable passée, mais idéalement c'est persistant.
    const currentAttempt = attemptCount_ || (orderForAttempts.assignment_attempt_count || 0) + 1;


    logger.info(
      `Attempt #${currentAttempt} to find next driver for Order ${orderId}, excluding ${excludeDriverIds.length} drivers: [${excludeDriverIds.join(', ')}]`
    )

    if (currentAttempt > MAX_ASSIGNMENT_ATTEMPTS && orderForAttempts.status_logs[0]?.status === OrderStatus.PENDING && !orderForAttempts.driver_id) {
      logger.error(`Max attempts (${MAX_ASSIGNMENT_ATTEMPTS}) reached for Order ${orderId}. Escalating.`)
      await this.escalateUnassignedOrder(orderId) // Mettre à jour l'order.assignment_attempt_count ici
      return
    }

    // Mettre à jour le compteur de tentatives sur la commande
    // Envisager une transaction si plusieurs mises à jour simultanées sont possibles
    if (currentAttempt <= MAX_ASSIGNMENT_ATTEMPTS) {
      await Order.query().where('id', orderId).update({ assignment_attempt_count: currentAttempt });
    }


    let order: Order | null = null // Redéclarer pour le scope de la transaction
    const trx = await db.transaction()

    try {
      order = await Order.query({ client: trx })
        .where('id', orderId)
        .preload('pickup_address')
        .preload('route_legs')
        .preload('packages')
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1))
        .first()

      if (!order) {
        logger.warn(`Order ${orderId} not found during reassignment.`)
        await trx.rollback()
        return
      }
      // ... (vérifications cruciales : PENDING, pas déjà assigné, pas d'offre active) ...
      // Ces vérifications sont TRÈS importantes
      const currentStatus = order.status_logs[0]?.status
      if (currentStatus !== OrderStatus.PENDING) {
        logger.warn(`Order ${orderId} no longer PENDING (Status: ${currentStatus}). Aborting offer.`)
        await trx.rollback(); return;
      }
      if (order.driver_id) {
        logger.warn(`Order ${orderId} already has driver ${order.driver_id}. Aborting offer.`)
        await trx.rollback(); return;
      }
      if (order.offered_driver_id) {
        logger.warn(`Order ${orderId} already has an active offer to ${order.offered_driver_id}. Aborting offer.`)
        await trx.rollback(); return;
      }
      if (!order.pickup_address) {
        logger.error(`Order ${orderId} missing pickup address. Cannot find drivers.`)
        await trx.rollback(); return;
      }


      // ... (logique de recherche de driver, similaire à avant) ...
      const totalWeightG = order.packages.reduce((sum, pkg) => sum + (pkg.dimensions?.weight_g || 0) * (pkg.quantity || 1), 0)
      const pickupPoint = order.pickup_address.coordinates.coordinates
      const searchRadiusMeters = DRIVER_SEARCH_RADIUS_KM
      const nowMinus5Minutes = DateTime.now().minus({ minutes: 15 }).toISO() //TODO a diminuer a  5 minutes
      const ASSIGNMENT_MAX_CANDIDATES = 500

      const availableDrivers = await Driver.query({ client: trx }) // Utiliser la trx pour la lecture aussi
        .select('drivers.*') // Assurez-vous que fcm_token est bien sélectionné
        .where('latest_status', DriverStatus.ACTIVE) // Suppose un champ dénormalisé
        .preload('vehicles', (vQuery) => vQuery.where('status', VehicleStatus.ACTIVE))
        .whereNotNull('current_location')
        // .where('last_location_update', '>', nowMinus5Minutes) // Localisation récente
        // .whereRaw('ST_DistanceSphere(current_location::geometry, ST_MakePoint(?, ?)::geometry) <= ?', [pickupPoint[0], pickupPoint[1], searchRadiusMeters])
        .whereNotIn('drivers.id', excludeDriverIds) // Exclut les précédents
        // TODO: Ajouter d'autres critères (véhicule compatible, etc.)
        // .orderByRaw('ST_DistanceSphere(current_location::geometry, ST_MakePoint(?, ?)::geometry) ASC', [pickupPoint[0], pickupPoint[1]]) // Trier par proximité
        .limit(ASSIGNMENT_MAX_CANDIDATES) // Chercher parmi les 10 plus proches par exemple
        .exec()
      logger.info({ orderId, count: availableDrivers.length, searchRadiusMeters, nowMinus5Minutes },
        `Found ${availableDrivers.length} potentially available drivers within ${searchRadiusMeters}m with location updated after ${nowMinus5Minutes}.`
      );

      if (availableDrivers.length === 0) {
        logger.warn({ orderId, searchRadiusMeters, nowMinus5Minutes }, "No drivers found matching initial criteria (status, location freshness, radius).");
      }

      const suitableDriver = availableDrivers.find(driver =>
        driver.vehicles.length > 0
        // && driver.vehicles.some(v => v.max_weight_kg === null || v.max_weight_kg * 1000 >= totalWeightG) // Comparer en grammes ou kg consistent
        // TODO: Ajouter filtrage véhicule plus complexe ici si nécessaire
      )

      logger.info({ suitableDriver }, 'Suitable driver found for Order')

      if (suitableDriver) {


        const previousDriverStatus = await DriversStatus.query({ client: trx }) // Récupérer le dernier statut pour assignments_in_progress_count
          .where('driver_id', suitableDriver.id)
          .orderBy('changed_at', 'desc')
          .first();




        // const selectedDriver = suitableDriver
        const offerExpiresAt = DateTime.now().plus({ seconds: OFFER_DURATION_SECONDS })

        order.offered_driver_id = suitableDriver.id
        order.offer_expires_at = offerExpiresAt
        // `assignment_attempt_count` a déjà été mis à jour avant la transaction
        await order.useTransaction(trx).save() // Sauvegarde via trx

        await OrderStatusLog.create(
          {
            id: cuid(),
            order_id: orderId,
            status: OrderStatus.PENDING, // Statut devient PENDING
            changed_at: DateTime.now(),
            // changed_by_user_id: adminUser.id, // L'admin initie ce statut
            metadata: { reason: 'assigned_by_assignment_worker', waypoint_sequence: -1, waypoint_status: undefined, waypoint_type: undefined, }, // Metadata indiquant l'origine
            current_location: order.pickup_address.coordinates,
          },
          { client: trx }
        )
        await DriversStatus.create(
          {
            id: cuid(),
            driver_id: suitableDriver.id,
            status: DriverStatus.OFFERING, // <--- Mettre à jour le statut
            changed_at: DateTime.now(),
            assignments_in_progress_count: previousDriverStatus?.assignments_in_progress_count || 0,
            metadata: { reason: `offered_order_${orderId} attempt: ${currentAttempt}` },
          },
          { client: trx }
        );
        await Driver.query({ client: trx }).where('id', suitableDriver.id).update({ latest_status: DriverStatus.OFFERING });

        logger.info(
          { orderId: order.id, driverId: suitableDriver.id, attempt: currentAttempt, expiresAt: offerExpiresAt.toISO() },
          `Offering Order to Driver (Attempt ${currentAttempt})`
        )

        if (suitableDriver.fcm_token) {
          const notifTitle = `Nouvelle Mission Proposée (Tent. ${currentAttempt})`
          const notifBody = `Course #${order.id.substring(0, 6)}... Rém: ${order.remuneration} EUR. Exp: ${offerExpiresAt.toFormat('HH:mm:ss')}`
          const notifData = {
            order_id: order.id,
            type: NotificationType.NEW_MISSION_OFFER, // Assurez-vous que ce type est bien géré
          }
          await redisHelper.enqueuePushNotification({
            fcmToken: suitableDriver.fcm_token,
            title: notifTitle,
            body: notifBody,
            data: notifData,
          })
        } else {
          logger.warn(`Driver ${suitableDriver.id} has no FCM token. Offer made but not notified via push.`)
        }
        // L'événement RedisHelper.publishNewMissionOffer n'est plus appelé ici, car l'offre est gérée en DB
        // et la notification est envoyée directement. Si un autre système doit savoir qu'une offre est active,
        // alors cet événement serait pertinent. Pour l'instant, on se base sur les champs DB.

        await trx.commit()
      } else {
        logger.warn(`No suitable driver found for Order ${orderId} in attempt #${currentAttempt}.`)
        await trx.rollback() // Rien n'a été modifié dans la transaction
        // Si c'est la dernière tentative, l'escalade a déjà été appelée ou le sera au prochain passage.
        // Pas besoin de `this.escalateUnassignedOrder(orderId)` ici si `MAX_ASSIGNMENT_ATTEMPTS` est géré au début.
      }
    } catch (error) {
      if (!trx.isCompleted) await trx.rollback()
      logger.error(
        { err: error, orderId, excluded: excludeDriverIds, attempt: currentAttempt },
        `🚨 CRITICAL error during findAndOfferNextDriver.`
      )
      // Si une offre a été partiellement faite avant l'erreur, elle sera rollbackée.
    }
  }

  /**
   * Gère l'escalade pour une commande non assignable.
   */
  async escalateUnassignedOrder(orderId: string) {
    logger.error(`ESCALATION for Order ${orderId}: Assignment failed after ${MAX_ASSIGNMENT_ATTEMPTS} attempts.`)
    const trx = await db.transaction()
    try {
      const order = await Order.query({ client: trx }).where('id', orderId).first()
      if (!order) {
        logger.warn(`Order ${orderId} not found during escalation.`)
        await trx.rollback(); return;
      }

      // Option 1: Marquer la commande comme ayant échoué à être assignée
      // Cela pourrait être un statut spécifique ou un log.
      // Pour cet exemple, on publie un événement et on logue.
      // Mettre à jour `order.assignment_attempt_count` si ce n'est pas déjà fait
      order.assignment_attempt_count = MAX_ASSIGNMENT_ATTEMPTS; // S'assurer qu'il est au max
      // await order.save(); // Déjà dans une transaction

      // Notifier les admins / système de monitoring
      logger.info(`Notifying admins about unassigned Order ${orderId}. (Simulation)`)
      // await NotificationHelper.sendAdminAlert(...) OU publier un événement admin

      // Publier un événement que la mission est annulée par le système
      await redisHelper.publishMissionCancelledBySystem(orderId, 'NO_DRIVER_FOUND_AFTER_MAX_ATTEMPTS')
      // Ceci sera traité par handleOrderTerminalState pour nettoyer l'offre si besoin.

      // Optionnel: Changer le statut de la commande en 'FAILED_ASSIGNMENT' ou similaire
      // await OrderStatusLog.create({ orderId, status: OrderStatus.FAILED_ASSIGNMENT, /*...*/ }, { client: trx });
      // order.status = OrderStatus.FAILED_ASSIGNMENT; // Si vous avez un champ status direct

      await order.save(); // Sauver les changements comme assignment_attempt_count
      await trx.commit()
      logger.info(`Order ${orderId} escalated: marked for admin review / system cancellation event published.`)

    } catch (error) {
      await trx.rollback()
      logger.error({ err: error, orderId }, 'Failed to escalate unassigned order.')
    }
  }

  /**
   * Nettoie une offre active pour une commande, typiquement après refus, expiration, ou acceptation.
   * @param orderId L'ID de la commande.
   * @param expectedDriverId L'ID du chauffeur qui était censé avoir l'offre (pour sécurité).
   * @param forceClear Si true, nettoie l'offre même si `expectedDriverId` ne correspond pas (utile si la commande n'est plus PENDING).
   * @param trx La transaction DB existante
   * @returns True si l'offre a été nettoyée, false sinon.
   */
  private async clearCurrentOffer(orderId: string, expectedDriverId: string, forceClear: boolean = false, trx?: any): Promise<{ cleaned: boolean; driverIdWhoseOfferWasCleaned?: string }> {
    try {
      const order = await Order.query({ client: trx }).where('id', orderId).first()

      if (!order) {
        logger.warn(`Order ${orderId} not found for clearing offer.`)
        await trx.rollback();
        return { cleaned: false };
      }

      if (order.offered_driver_id === null) {
        // logger.trace(`Order ${orderId} had no active offer. No clearing needed.`);
        await trx.rollback();
        return { cleaned: false }; // Pas d'offre à nettoyer, mais ce n'est pas un échec de nettoyage.
        // Retourner false car rien n'a été "nettoyé".
      }
      const driverIdWhoseOfferWasCleaned = order.offered_driver_id;

      if (!forceClear && order.offered_driver_id !== expectedDriverId) {
        logger.warn(
          { orderId, offered: order.offered_driver_id, expected: expectedDriverId },
          `Attempted to clear offer for driver ${expectedDriverId}, but current offer is for ${order.offered_driver_id}. No change made.`
        )
        await trx.rollback();
        return { cleaned: false };
      }

      // Si on est ici, soit forceClear est true, soit expectedDriverId correspond.
      logger.info(
        { orderId, driverId: order.offered_driver_id, reason: forceClear ? "forced" : `match_expected (${expectedDriverId})` },
        `Clearing active offer for order.`
      )
      order.offered_driver_id = null
      order.offer_expires_at = null
      await order.save()
      await trx.commit()
      return { cleaned: true, driverIdWhoseOfferWasCleaned }

    } catch (error) {
      await trx.rollback()
      logger.error({ err: error, orderId, expectedDriverId }, 'Error during clearCurrentOffer.')
      return { cleaned: false }
    }
  }


  private async gracefulShutdown(signal: string) {
    if (!this.isRunning) return; // Déjà en cours d'arrêt
    logger.info(`Received ${signal}. Attempting graceful shutdown of Assignment Worker...`);
    this.isRunning = false;

    if (this.expirationScanTimer) {
      clearTimeout(this.expirationScanTimer);
      logger.info('Expiration scan timer cleared.');
    }

    // Donner un peu de temps à la boucle XREAD de se terminer si elle est bloquée
    // On pourrait utiliser XREADGROUP avec un ID spécifique pour ce worker pour le débloquer, mais c'est plus complexe.
    // Une simple attente est souvent suffisante.
    logger.info('Waiting for current Redis operations to complete (max 2 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    logger.info('👋 Assignment Worker stopped.');
    process.exit(0); // Quitter proprement
  }

  // `close` n'est plus explicitement appelé par AdonisJS pour les commandes de longue durée sans `SIGTERM/SIGINT`
  // La gestion est faite via `gracefulShutdown`
  // public async close() { /* ... */ }

} // Fin de la classe AssignmentWorker