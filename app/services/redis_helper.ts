// app/services/redis_helper.ts
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import redis from '@adonisjs/redis/services/main'

// Stream keys from environment variables
const MISSION_OFFER_STREAM_KEY = env.get('REDIS_MISSION_OFFER_STREAM', 'mission_offers_stream')
const ASSIGNMENT_LOGIC_STREAM_KEY = env.get('REDIS_ASSIGNMENT_STREAM', 'assignment_logic_stream')

const ASSIGNMENT_LOGIC_STREAM = env.get('REDIS_ASSIGNMENT_STREAM', 'assignment_logic_stream')
const NOTIFICATION_QUEUE_STREAM = env.get('REDIS_NOTIFICATION_STREAM', 'notifications_queue_stream')

// Enum for event types to ensure consistency
enum RedisEventType {
  MISSION_OFFER = 'mission_offer',
  MISSION_ACCEPTED = 'mission_accepted',
  MISSION_REFUSED = 'mission_refused',
  MISSION_COMPLETED = 'mission_completed',
  MISSION_CANCELLED = 'mission_cancelled',
  MISSION_FAILED = 'mission_failed',
}

// Interface for event data to enforce structure
interface EventData {
  type: RedisEventType
  orderId: string
  driverId?: string
  [key: string]: string | number | undefined
}

class RedisHelper {
  /**
   * Publishes an event to a Redis Stream with retry logic.
   * @param streamKey - The Redis Stream key (e.g., mission_offers_stream).
   * @param eventData - The event data as key-value pairs.
   * @param retries - Number of retries on failure (default: 3).
   * @returns The message ID or null if publishing fails.
   */
  private async publishEvent(
    streamKey: string,
    eventData: EventData,
    retries: number = 3
  ): Promise<string | null> {
    // Validate required fields
    if (!eventData.orderId) {
      logger.error({ eventData }, `Cannot publish event to ${streamKey}: Missing orderId`)
      return null
    }
    if (!eventData.type) {
      logger.error({ eventData }, `Cannot publish event to ${streamKey}: Missing event type`)
      return null
    }

    // Convert event data to Redis-compatible array
    const redisData = Object.entries(eventData)
      .filter(([_, value]) => value !== undefined && value !== null)
      .flatMap(([key, value]) => [key, String(value)])

    let attempt = 0
    while (attempt <= retries) {
      try {
        const messageId = await redis.xadd(streamKey, '*', ...redisData)
        logger.info(
          {
            streamKey,
            eventType: eventData.type,
            orderId: eventData.orderId,
            messageId,
          },
          `Published event to Redis Stream`
        )
        return messageId
      } catch (error) {
        attempt++
        logger.warn(
          { err: error, streamKey, eventData, attempt },
          `Failed to publish event to Redis Stream (attempt ${attempt}/${retries})`
        )
        if (attempt > retries) {
          logger.error(
            { err: error, streamKey, eventData },
            `Exhausted retries for publishing event to Redis Stream`
          )
          // TODO: Trigger monitoring alert (e.g., Sentry, Datadog)
          return null
        }
        // Exponential backoff: wait 100ms * 2^attempt
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)))
      }
    }
    return null
  }

  /**
   * Publishes a new mission offer to the mission_offers_stream.
   * @param orderId - The order ID.
   * @param driverId - The driver ID.
   * @param initialRemuneration - The initial remuneration for the mission.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionOffer(
    orderId: string,
    driverId: string,
    initialRemuneration: number
  ): Promise<string | null> {
    if (initialRemuneration < 0) {
      logger.error({ orderId, driverId }, `Invalid remuneration: ${initialRemuneration}`)
      return null
    }

    const eventData: EventData = {
      type: RedisEventType.MISSION_OFFER,
      orderId,
      driverId,
      remuneration: initialRemuneration,
      timestamp: Date.now(),
      status: 'new',
    }

    return this.publishEvent(MISSION_OFFER_STREAM_KEY, eventData)
  }

  /**
   * Publishes a mission acceptance event to the assignment_logic_stream.
   * @param orderId - The order ID.
   * @param driverId - The driver ID who accepted the mission.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionAccepted(orderId: string, driverId: string): Promise<string | null> {
    const eventData: EventData = {
      type: RedisEventType.MISSION_ACCEPTED,
      orderId,
      driverId,
      timestamp: Date.now(),
    }

    return this.publishEvent(ASSIGNMENT_LOGIC_STREAM_KEY, eventData)
  }

  /**
   * Publishes a mission refusal event to the assignment_logic_stream.
   * @param orderId - The order ID.
   * @param refusingDriverId - The driver ID who refused the mission.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionRefused(orderId: string, refusingDriverId: string): Promise<string | null> {
    const eventData: EventData = {
      type: RedisEventType.MISSION_REFUSED,
      orderId,
      driverId: refusingDriverId,
      timestamp: Date.now(),
    }

    return this.publishEvent(ASSIGNMENT_LOGIC_STREAM_KEY, eventData)
  }

  /**
   * Publishes a mission completion event to the assignment_logic_stream.
   * Used by admin_mark_as_success to trigger driver payment.
   * @param orderId - The order ID.
   * @param driverId - The driver ID who completed the mission.
   * @param remuneration - The final remuneration amount.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionCompleted(
    orderId: string,
    driverId: string,
    remuneration: number
  ): Promise<string | null> {
    if (remuneration < 0) {
      logger.error({ orderId, driverId }, `Invalid remuneration: ${remuneration}`)
      return null
    }

    const eventData: EventData = {
      type: RedisEventType.MISSION_COMPLETED,
      orderId,
      driverId,
      remuneration,
      timestamp: Date.now(),
    }

    return this.publishEvent(ASSIGNMENT_LOGIC_STREAM_KEY, eventData)
  }

  /**
   * Publishes a mission cancellation event to the assignment_logic_stream.
   * Used by admin_cancel_order to notify workers of cancellation.
   * @param orderId - The order ID.
   * @param driverId - The driver ID (if assigned).
   * @param reasonCode - The cancellation reason code.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionCancelled(
    orderId: string,
    driverId: string | null,
    reasonCode: string
  ): Promise<string | null> {
    const eventData: EventData = {
      type: RedisEventType.MISSION_CANCELLED,
      orderId,
      driverId: driverId ?? undefined,
      reasonCode,
      timestamp: Date.now(),
    }

    return this.publishEvent(ASSIGNMENT_LOGIC_STREAM_KEY, eventData)
  }

  /**
   * Publishes a mission failure event to the assignment_logic_stream.
   * Used by admin_mark_as_failed to notify workers of failure.
   * @param orderId - The order ID.
   * @param driverId - The driver ID (if assigned).
   * @param reasonCode - The failure reason code.
   * @param details - Additional details about the failure.
   * @returns The message ID or null if publishing fails.
   */
  async publishMissionFailed(
    orderId: string,
    driverId: string | null,
    reasonCode: string,
    details: string
  ): Promise<string | null> {
    const eventData: EventData = {
      type: RedisEventType.MISSION_FAILED,
      orderId,
      driverId: driverId ?? undefined,
      reasonCode,
      details,
      timestamp: Date.now(),
    }

    return this.publishEvent(ASSIGNMENT_LOGIC_STREAM_KEY, eventData)
  }

  /**
   * Ajoute une demande d'envoi de notification Push à la queue Redis.
   * @param fcmToken Le token FCM (si déjà connu, sinon le worker le cherchera)
   * @param notification Contenu de la notification (title, body)
   * @param data Payload de données pour la notification
   * @returns L'ID du message ajouté au stream ou null en cas d'erreur.
   */
  async enqueuePushNotification(
    // target: 'client' | 'driver', // Peut être utile si le worker cherche le token
    // targetId: string,
    fcmToken: string | null | undefined, // Peut être null, le worker peut essayer de le trouver
    title: string,
    body: string,
    data?: { [key: string]: any } // Accepte n'importe quel objet pour les data
  ): Promise<string | null> {
    if (!fcmToken) {
      logger.warn({ title, body }, `Tentative d'enqueue notif sans FCM token. Skipping.`)
      // Ou: Le worker pourrait chercher le token basé sur targetId si fourni. Pour l'instant on skip.
      return null
    }

    try {
      // Sérialise les données si elles existent
      const dataString = data ? JSON.stringify(data) : '{}'

      const eventData = [
        'fcmToken',
        fcmToken,
        'title',
        title,
        'body',
        body,
        'data',
        dataString, // Data en JSON string
        'timestamp',
        String(Date.now()),
      ]

      const messageId = await redis.xadd(NOTIFICATION_QUEUE_STREAM, '*', ...eventData)
      logger.debug(
        `Notification enqueued to Redis Stream ${NOTIFICATION_QUEUE_STREAM}. Target Token: ${fcmToken}, Msg ID: ${messageId}`
      )
      return messageId
    } catch (error) {
      logger.error(
        { err: error, fcmToken, title },
        `Failed to enqueue notification to Redis Stream ${NOTIFICATION_QUEUE_STREAM}`
      )
      return null
    }
  }
}

export default new RedisHelper()
