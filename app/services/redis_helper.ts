// app/services/redis_helper.ts
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import redis from '@adonisjs/redis/services/main'
import { NotificationPayload } from '../contracts/events.js' // Supposons que cela existe et est correct

// --- Stream Keys ---
// Stream pour les offres initiales aux chauffeurs (consommé par un système qui envoie la notif/affiche l'offre)
const MISSION_OFFER_STREAM_KEY = env.get('REDIS_MISSION_OFFER_STREAM')

// Stream pour les événements qui impactent la logique d'assignation (consommé par AssignmentWorker)
const ASSIGNMENT_EVENTS_STREAM_KEY = env.get('REDIS_ASSIGNMENT_LOGIC_STREAM')

// Stream pour les notifications génériques (consommé par NotificationWorker)
const NOTIFICATION_QUEUE_STREAM = env.get('REDIS_NOTIFICATION_QUEUE_STREAM')

// --- Event Types ---
// Enum pour les types d'événements Redis pour plus de cohérence et de maintenabilité
export enum MissionLifecycleEvent {
  // Événements pour MISSION_OFFER_STREAM_KEY (ou directement pour une notification)
  NEW_OFFER_PROPOSED = 'mission_new_offer_proposed', // Une nouvelle offre est proposée à un chauffeur spécifique

  // Événements pour ASSIGNMENT_EVENTS_STREAM_KEY (pour AssignmentWorker)
  OFFER_ACCEPTED_BY_DRIVER = 'mission_offer_accepted_by_driver', // Un chauffeur a ACCEPTÉ une offre
  OFFER_REFUSED_BY_DRIVER = 'mission_offer_refused_by_driver', // Un chauffeur a REFUSÉ une offre
  OFFER_EXPIRED_FOR_DRIVER = 'mission_offer_expired_for_driver', // L'offre a EXPIRÉ pour un chauffeur (peut être publié par un autre service ou par AssignmentWorker lui-même)
  MANUALLY_ASSIGNED = 'mission_manually_assigned', // Une mission a été assignée manuellement par un admin

  // Événements pour informer D'AUTRES systèmes (par exemple, facturation, suivi),
  // pourraient aller sur ASSIGNMENT_EVENTS_STREAM_KEY ou un autre stream dédié si nécessaire.
  // AssignmentWorker pourrait aussi les écouter pour arrêter la recherche.
  COMPLETED = 'mission_completed', // La mission est terminée avec succès
  CANCELLED_BY_ADMIN = 'mission_cancelled_by_admin', // La mission a été annulée par un admin
  CANCELLED_BY_SYSTEM = 'mission_cancelled_by_system', // La mission a été annulée par le système (ex: pas de chauffeur trouvé après N tentatives)
  FAILED = 'mission_failed', // La mission a échoué pour une raison opérationnelle

  NEW_ORDER_READY_FOR_ASSIGNMENT = 'mission_new_order_ready_for_assignment',
}

// --- Event Data Structure ---
// Interface de base pour les données d'événements liés aux missions


export interface MissionEventData {
  type: MissionLifecycleEvent
  orderId: string
  driverId?: string
  timestamp: number
  [key: string]: string | number | boolean | undefined | null
}

// Interface spécifique pour une nouvelle offre
export interface NewOfferProposedData extends MissionEventData {
  type: MissionLifecycleEvent.NEW_OFFER_PROPOSED
  driverId: string // Obligatoire ici
  remuneration: number
  offerExpiresAt: string // ISO string pour l'expiration de cette offre spécifique
}

export interface RawInitialAssignmentDetails {
  pickupCoordinates?: [number, number];
  totalWeightG?: number;
  initialRemuneration?: number;
}


export interface NewOrderReadyForAssignmentData extends MissionEventData {
  type: MissionLifecycleEvent.NEW_ORDER_READY_FOR_ASSIGNMENT;
  // Ce champ sera une chaîne JSON dans le message Redis
  initialAssignmentDetails?: string; // CHANGEMENT ICI: le type est string
  initialAssignmentDetails_parsed?: any;
}
// Interface spécifique pour un refus
export interface OfferRefusedData extends MissionEventData {
  type: MissionLifecycleEvent.OFFER_REFUSED_BY_DRIVER
  driverId: string // Le chauffeur qui refuse (anciennement refusingDriverId)
  reason?: string // Optionnel: raison du refus
}

// Interface spécifique pour une expiration
export interface OfferExpiredData extends MissionEventData {
  type: MissionLifecycleEvent.OFFER_EXPIRED_FOR_DRIVER
  driverId: string // Le chauffeur pour qui l'offre a expiré
}

// Interface spécifique pour une acceptation
export interface OfferAcceptedData extends MissionEventData {
  type: MissionLifecycleEvent.OFFER_ACCEPTED_BY_DRIVER
  driverId: string // Le chauffeur qui accepte
}

// Interface spécifique pour une complétion
export interface MissionCompletedData extends MissionEventData {
  type: MissionLifecycleEvent.COMPLETED
  driverId: string // Chauffeur qui a complété
  finalRemuneration: number // Rémunération finale (peut différer de l'initiale)
}

// Interface pour annulation
export interface MissionCancelledData extends MissionEventData {
  type: MissionLifecycleEvent.CANCELLED_BY_ADMIN | MissionLifecycleEvent.CANCELLED_BY_SYSTEM
  reasonCode: string
  cancelledBy: 'admin' | 'system' | 'driver' // Qui a initié
  // driverId peut être présent si la mission était déjà assignée
}

// Interface pour échec
export interface MissionFailedData extends MissionEventData {
  type: MissionLifecycleEvent.FAILED
  reasonCode: string
  details?: string
  // driverId peut être présent si la mission était déjà assignée
}


class RedisHelper {
  /**
   * Publishes an event to a Redis Stream with retry logic.
   * @param streamKey - The Redis Stream key.
   * @param eventData - The event data.
   * @param retries - Number of retries on failure (default: 3).
   * @returns The message ID or null if publishing fails.
   */
  private async publishEventInternal( // Renommé pour éviter confusion avec les méthodes publiques
    streamKey: string,
    eventData: MissionEventData, // Utilise notre interface de base
    retries: number = 3
  ): Promise<string | null> {
    if (!eventData.orderId) {
      logger.error({ eventData }, `Cannot publish event to ${streamKey}: Missing orderId`)
      return null
    }
    if (!eventData.type) {
      logger.error({ eventData }, `Cannot publish event to ${streamKey}: Missing event type`)
      return null
    }
    const redisData: string[] = []
    for (const [key, value] of Object.entries(eventData)) {
      if (value !== undefined && value !== null) {
        if (typeof value === 'object' && value !== null) {
          redisData.push(key, JSON.stringify(value));
        } else {
          redisData.push(key, String(value));
        }
      }
    }

    let attempt = 0
    while (attempt <= retries) {
      try {
        const messageId = await redis.xadd(streamKey, '*', ...redisData)
        logger.info(
          {
            streamKey,
            eventType: eventData.type,
            orderId: eventData.orderId,
            driverId: eventData.driverId,
            messageId,
          },
          `Published mission event to Redis Stream`
        )
        return messageId
      } catch (error) {
        attempt++
        logger.warn(
          { err: error, streamKey, eventData, attempt, maxRetries: retries },
          `Failed to publish mission event (attempt ${attempt}/${retries})`
        )
        if (attempt > retries) {
          logger.error(
            { err: error, streamKey, eventData },
            `Exhausted retries for publishing mission event`
          )
          // TODO: Trigger monitoring alert
          return null
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)))
      }
    }
    return null
  }

  // --- Méthodes de publication spécifiques aux missions ---

  /**
   * Publishes a new mission offer to a driver.
   * This event might be consumed by a system that notifies the driver.
   * It does NOT directly trigger reassignment logic, but its expiration or refusal will.
   *
   * @param orderId - The order ID.
   * @param driverId - The driver ID to whom the offer is made.
   * @param remuneration - The remuneration for this offer.
   * @param offerExpiresAt - ISO string timestamp for when this specific offer expires.
   * @returns The message ID or null if publishing fails.
   */
  async publishNewMissionOffer(
    orderId: string,
    driverId: string,
    remuneration: number,
    offerExpiresAt: string // ex: DateTime.now().plus({ seconds: 60 }).toISO()
  ): Promise<string | null> {
    if (remuneration < 0) {
      logger.error(
        { orderId, driverId, remuneration },
        `Invalid remuneration for new mission offer`
      )
      return null
    }
    // TODO: Valider que offerExpiresAt est une date ISO valide et dans le futur

    const eventData: NewOfferProposedData = {
      type: MissionLifecycleEvent.NEW_OFFER_PROPOSED,
      orderId,
      driverId,
      remuneration,
      offerExpiresAt,
      timestamp: Date.now(),
    }
    // Ce stream est-il le bon ? Si c'est juste pour notifier, peut-être direct vers NOTIFICATION_QUEUE_STREAM
    // Ou si un autre service gère l'offre active, alors MISSION_OFFER_STREAM_KEY est ok.
    // Pour l'instant, je garde MISSION_OFFER_STREAM_KEY comme dans le code original.
    return this.publishEventInternal(MISSION_OFFER_STREAM_KEY, eventData)
  }

  /**
   * Publishes a mission acceptance event.
   * Consumed by AssignmentWorker to stop further searches and confirm assignment.
   *
   * @param orderId - The order ID.
   * @param driverId - The driver ID who accepted the mission.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionOfferAccepted(orderId: string, driverId: string): Promise<string | null> {
    const eventData: OfferAcceptedData = {
      type: MissionLifecycleEvent.OFFER_ACCEPTED_BY_DRIVER,
      orderId,
      driverId,
      timestamp: Date.now(),
    }
    return this.publishEventInternal(ASSIGNMENT_EVENTS_STREAM_KEY, eventData)
  }

  /**
   * Publishes a mission refusal event.
   * Consumed by AssignmentWorker to try finding another driver.
   *
   * @param orderId - The order ID.
   * @param driverId - The driver ID who refused the mission.
   * @param reason - Optional reason for refusal.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionOfferRefused(
    orderId: string,
    driverId: string,
    reason?: string
  ): Promise<string | null> {
    const eventData: OfferRefusedData = {
      type: MissionLifecycleEvent.OFFER_REFUSED_BY_DRIVER,
      orderId,
      driverId, // Le chauffeur qui a refusé
      reason,
      timestamp: Date.now(),
    }
    return this.publishEventInternal(ASSIGNMENT_EVENTS_STREAM_KEY, eventData)
  }

  /**
   * Publishes an event indicating an offer has expired for a specific driver.
   * Consumed by AssignmentWorker to try finding another driver.
   * This might be published by AssignmentWorker itself after a scan, or by another service.
   *
   * @param orderId - The order ID.
   * @param driverId - The driver ID for whom the offer expired.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionOfferExpired(orderId: string, driverId: string): Promise<string | null> {
    const eventData: OfferExpiredData = {
      type: MissionLifecycleEvent.OFFER_EXPIRED_FOR_DRIVER,
      orderId,
      driverId,
      timestamp: Date.now(),
    }
    return this.publishEventInternal(ASSIGNMENT_EVENTS_STREAM_KEY, eventData)
  }

  /**
   * Publishes a mission completion event.
   * Can be consumed by various services (billing, stats, AssignmentWorker to finalize).
   *
   * @param orderId - The order ID.
   * @param driverId - The driver ID who completed the mission.
   * @param finalRemuneration - The final remuneration amount.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionCompleted(
    orderId: string,
    driverId: string,
    finalRemuneration: number
  ): Promise<string | null> {
    if (finalRemuneration < 0) {
      logger.error(
        { orderId, driverId, finalRemuneration },
        `Invalid final remuneration for mission completion`
      )
      return null
    }
    const eventData: MissionCompletedData = {
      type: MissionLifecycleEvent.COMPLETED,
      orderId,
      driverId,
      finalRemuneration,
      timestamp: Date.now(),
    }
    // Pourrait aller sur un stream plus général 'mission_updates_stream' ou rester sur ASSIGNMENT_EVENTS_STREAM_KEY
    // si AssignmentWorker doit en être informé (par exemple pour nettoyer des états internes).
    return this.publishEventInternal(ASSIGNMENT_EVENTS_STREAM_KEY, eventData)
  }

  /**
   * Publishes a mission cancellation event (initiated by an admin).
   *
   * @param orderId - The order ID.
   * @param reasonCode - The cancellation reason code.
   * @param assignedDriverId - Optional: The driver ID if the mission was already assigned.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionCancelledByAdmin(
    orderId: string,
    reasonCode: string,
    assignedDriverId?: string
  ): Promise<string | null> {
    const eventData: MissionCancelledData = {
      type: MissionLifecycleEvent.CANCELLED_BY_ADMIN,
      orderId,
      driverId: assignedDriverId,
      reasonCode,
      cancelledBy: 'admin',
      timestamp: Date.now(),
    }
    return this.publishEventInternal(ASSIGNMENT_EVENTS_STREAM_KEY, eventData)
  }

  /**
 * Publishes a mission cancellation event (initiated by the system).
 * E.g., no driver found after max attempts.
 *
 * @param orderId - The order ID.
 * @param reasonCode - The cancellation reason code.
 * @returns The message ID or null if publishing fails.
 */
  async publishMissionCancelledBySystem(
    orderId: string,
    reasonCode: string,
  ): Promise<string | null> {
    const eventData: MissionCancelledData = {
      type: MissionLifecycleEvent.CANCELLED_BY_SYSTEM,
      orderId,
      reasonCode,
      cancelledBy: 'system',
      timestamp: Date.now(),
    }
    return this.publishEventInternal(ASSIGNMENT_EVENTS_STREAM_KEY, eventData)
  }


  /**
   * Publishes a mission failure event.
   *
   * @param orderId - The order ID.
   * @param reasonCode - The failure reason code.
   * @param details - Additional details about the failure.
   * @param assignedDriverId - Optional: The driver ID if the mission was assigned.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionFailed(
    orderId: string,
    reasonCode: string,
    details?: string,
    assignedDriverId?: string
  ): Promise<string | null> {
    const eventData: MissionFailedData = {
      type: MissionLifecycleEvent.FAILED,
      orderId,
      driverId: assignedDriverId,
      reasonCode,
      details,
      timestamp: Date.now(),
    }
    return this.publishEventInternal(ASSIGNMENT_EVENTS_STREAM_KEY, eventData)
  }

  /**
   * Publishes an event when a mission is manually assigned to a driver by an admin.
   * Consumed by AssignmentWorker to potentially stop any ongoing automated assignment processes
   * and to ensure the system reflects the manual assignment.
   *
   * @param orderId - The order ID.
   * @param driverId - The driver ID to whom the mission was manually assigned.
   * @param assignedByAdminId - The ID of the admin who performed the assignment.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionManuallyAssigned(
    orderId: string,
    driverId: string,
    assignedByAdminId: string
  ): Promise<string | null> {
    const eventData: MissionEventData & { assignedByAdminId: string } = { // Utilisation d'une intersection de type ici
      type: MissionLifecycleEvent.MANUALLY_ASSIGNED,
      orderId,
      driverId,
      assignedByAdminId,
      timestamp: Date.now(),
    };
    return this.publishEventInternal(ASSIGNMENT_EVENTS_STREAM_KEY, eventData);
  }


  /**
 * Publishes an event indicating a new order is created and ready for driver assignment.
 * Consumed by AssignmentWorker to initiate the driver search and offer process.
 *
 * @param orderId - The ID of the newly created order.
 * @param details - Optional: Key details about the order to help the first assignment attempt.
 * @returns The message ID or null if publishing fails.
 */
  async publishNewOrderReadyForAssignment(
    orderId: string,
    details?: RawInitialAssignmentDetails // Utilise le type de l'interface
  ): Promise<string | null> {
    const eventData: NewOrderReadyForAssignmentData = {
      type: MissionLifecycleEvent.NEW_ORDER_READY_FOR_ASSIGNMENT,
      orderId,
      timestamp: Date.now(),
      initialAssignmentDetails: details ? JSON.stringify(details) : undefined,
    }
    return this.publishEventInternal(ASSIGNMENT_EVENTS_STREAM_KEY, eventData)
  }


  /**
   * Ajoute une demande d'envoi de notification Push à la queue Redis.
   * (Cette méthode reste globalement la même, mais utilise le nouveau nom de stream)
   * @param notificationPayload - Contenu de la notification.
   * @returns L'ID du message ajouté au stream ou null en cas d'erreur.
   */
  async enqueuePushNotification(
    notificationPayload: NotificationPayload // Assurez-vous que NotificationPayload est bien défini
  ): Promise<string | null> {
    const { fcmToken, title, body, data } = notificationPayload;

    if (!fcmToken) { // Ou !fcmToken si c'est une chaîne vide et non null/undefined
      logger.warn({ title, body, data }, `Attempting to enqueue notification without FCM token. Skipping.`);
      return null;
    }

    try {
      const dataString = data ? JSON.stringify(data) : '{}';
      const redisMessageData = [
        'fcmToken', fcmToken,
        'title', title,
        'body', body,
        'data', dataString,
        'timestamp', String(Date.now()),
      ];

      // S'il y a un type dans notificationPayload.data, on pourrait le sortir au niveau supérieur aussi
      if (data && typeof data === 'object' && 'type' in data) {
        redisMessageData.push('notificationType', String(data.type));
        logger.info({ notificationPayloadData: data, addedNotificationType: String(data.type) }, "Extracted 'type' for Redis message");
      } else {
        logger.info({ notificationPayloadData: data }, "'type' not found in data payload for Redis message");
      }


      const messageId = await redis.xadd(NOTIFICATION_QUEUE_STREAM, '*', ...redisMessageData);
      return messageId;
    } catch (error) {
      logger.error(
        { err: error, fcmToken, title, stream: NOTIFICATION_QUEUE_STREAM },
        `Failed to enqueue notification to Redis Stream`
      );
      return null;
    }
  }
}

export default new RedisHelper()