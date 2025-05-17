// app/commands/notification_worker.ts
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import redis from '@adonisjs/redis/services/main'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import NotificationHelper, {
  initializeFirebaseApp,
  type SendNotificationResult,
} from '#services/notification_helper'
import { setTimeout as sleep } from 'node:timers/promises'
import { NotificationType } from '#models/notification' // Assurez-vous de l'import

// --- Configuration ---
const NOTIFICATION_STREAM_KEY = env.get('REDIS_NOTIFICATION_STREAM', 'notifications_queue_stream')
const CONSUMER_GROUP_NAME = env.get(
  'REDIS_NOTIFICATION_CONSUMER_GROUP',
  'notification_workers_group'
)
// Noms plus spécifiques pour les variables d'env de ce worker
const POLLING_INTERVAL_MS = env.get('NOTIFICATION_WORKER_POLL_INTERVAL', 1000)
const MAX_NOTIFS_PER_POLL = env.get('NOTIFICATION_WORKER_MAX_EVENTS', 10)
const BLOCK_TIMEOUT_MS = env.get('NOTIFICATION_WORKER_BLOCK_MS', 5000)
const IDLE_TIMEOUT_BEFORE_CLAIM_MS = env.get('NOTIFICATION_WORKER_CLAIM_IDLE_MS', 60000)
const MAX_RETRY_BEFORE_DEADLETTER = env.get('NOTIFICATION_WORKER_MAX_RETRY', 5)
const DEAD_CONSUMER_IDLE_THRESHOLD_MS = env.get('NOTIFICATION_WORKER_DEAD_CONSUMER_IDLE_MS', 10 * 60 * 1000) // 10 minutes
const CLAIM_CHECK_FREQUENCY = env.get('NOTIFICATION_WORKER_CLAIM_CHECK_FREQUENCY', 5) // loops

// --- Types Redis (plus précis) ---
type RedisStreamMessage = [string, string[]] // [messageId, [field1, value1, ...]]
type RedisStreamReadGroupResult = [string, RedisStreamMessage[]][] | null // [[streamName, [msg1, msg2]], ...] | null
// Format XPENDING: [messageId, consumerName, idleTimeMs, deliveryCount]
type PendingMessageInfo = [string, string, number, number]
// XCLAIM retourne les messages comme XREAD/XREADGROUP
type ClaimedMessagesResult = RedisStreamMessage[] | null


export default class NotificationWorker extends BaseCommand {
  public static commandName = 'notification:worker'
  public static description =
    'Robustly listens to Redis Stream, sends push notifications, and handles PEL.'

  @flags.boolean({
    alias: 'c',
    description: 'Run cleanup for potentially dead consumers in the group before starting.',
  })
  declare cleanup: boolean

  private isRunning = true
  private consumerName: string = `notifworker_${process.pid}_${Date.now().toString(36)}`
  private claimCheckCounter = 0
  private lastPelCheckFoundMessages = true // Optimiste au début

  // Map pour stocker le deliveryCount des messages récupérés par XPENDING, avant XCLAIM
  private pendingMessageDeliveryCounts: Map<string, number> = new Map()

  public static options: CommandOptions = { startApp: true }

  private async ensureConsumerGroupExists() {
    try {
      await redis.xgroup('CREATE', NOTIFICATION_STREAM_KEY, CONSUMER_GROUP_NAME, '$', 'MKSTREAM')
      logger.info(
        `Redis Stream consumer group '${CONSUMER_GROUP_NAME}' created or already exists for stream '${NOTIFICATION_STREAM_KEY}'. Starting from new messages ($).`
      )
    } catch (error) {
      if (error instanceof Error && error.message.includes('BUSYGROUP')) {
        logger.info(`Redis Stream consumer group '${CONSUMER_GROUP_NAME}' already exists.`)
      } else {
        logger.error(
          { err: error },
          `Failed to create/ensure consumer group '${CONSUMER_GROUP_NAME}'.`
        )
        throw error
      }
    }
  }

  private async initialize() {
    initializeFirebaseApp() // Supposée idempotente et gérant ses erreurs
    logger.info(`🚀 Notification Worker (${this.consumerName}) starting... Stream: ${NOTIFICATION_STREAM_KEY}, Group: ${CONSUMER_GROUP_NAME}`)
    try {
      await this.ensureConsumerGroupExists()
      if (this.cleanup) {
        logger.info("Cleanup flag detected. Running dead consumer cleanup before starting main loop...")
        await this.cleanupDeadConsumers()
      }
    } catch (groupError) {
      logger.fatal({ err: groupError }, `Worker (${this.consumerName}) cannot start. Stopping.`)
      throw groupError
    }
  }

  private registerShutdownHandler() {
    const signalHandler = async (signal: string) => {
      if (!this.isRunning) return
      logger.info(`Received ${signal}. Shutting down worker (${this.consumerName}) gracefully...`)
      this.isRunning = false
      // Attendre un peu pour permettre à la boucle XREAD de se débloquer et au cycle de se terminer
      await sleep(Math.min(BLOCK_TIMEOUT_MS + 500, 3000))
      logger.info(`👋 Notification Worker (${this.consumerName}) stopped.`)
      process.exit(0)
    }
    process.on('SIGINT', () => signalHandler('SIGINT'))
    process.on('SIGTERM', () => signalHandler('SIGTERM'))
  }

  async run() {
    try {
      await this.initialize()
    } catch (initError) {
      this.exitCode = 1
      return
    }
    this.registerShutdownHandler()

    logger.info(`Listening for notifications. Claim check frequency: ${CLAIM_CHECK_FREQUENCY} idle loops. Max retries: ${MAX_RETRY_BEFORE_DEADLETTER}.`)

    while (this.isRunning) {
      let processedMessagesInCycle = 0
      try {
        let claimedMessages: RedisStreamMessage[] = []
        if (this.claimCheckCounter >= CLAIM_CHECK_FREQUENCY || this.lastPelCheckFoundMessages) {
          this.claimCheckCounter = 0
          claimedMessages = await this.claimPendingMessages()
          this.lastPelCheckFoundMessages = claimedMessages.length > 0
          if (claimedMessages.length > 0) {
            await this.processMessages(claimedMessages, true)
            processedMessagesInCycle += claimedMessages.length
          }
        } else {
          this.claimCheckCounter++
          logger.trace(
            `Skipping PEL check (iteration ${this.claimCheckCounter}/${CLAIM_CHECK_FREQUENCY})`
          )
        }

        if (!this.isRunning) break; // Vérifier avant de lire de nouveaux messages

        const newMessages = await this.readNewMessages()
        if (newMessages.length > 0) {
          await this.processMessages(newMessages, false)
          processedMessagesInCycle += newMessages.length
          this.claimCheckCounter = 0 // Reset si on a traité de nouveaux messages
          this.lastPelCheckFoundMessages = true // Optimiste pour le prochain check PEL
        }

        if (processedMessagesInCycle === 0 && this.isRunning) {
          // Petite pause si complètement idle pour éviter de marteler XREADGROUP si BLOCK_TIMEOUT_MS est court
          await sleep(200)
        }

      } catch (error) {
        logger.error(
          { err: error, consumer: this.consumerName },
          '🚨 CRITICAL Error in Worker main loop. Retrying after pause...'
        )
        if (this.isRunning) await sleep(POLLING_INTERVAL_MS * 2) // Pause plus longue
      }
    }
    logger.info(`Notification Worker (${this.consumerName}) loop ended.`)
  }

  private async readNewMessages(): Promise<RedisStreamMessage[]> {
    try {
      // XREADGROUP GROUP <group> <consumer> [COUNT <count>] [BLOCK <milliseconds>] STREAMS <key> >
      const streamsResult = (await redis.xreadgroup(
        'GROUP',
        CONSUMER_GROUP_NAME,
        this.consumerName,
        'COUNT',
        MAX_NOTIFS_PER_POLL,
        'BLOCK',
        BLOCK_TIMEOUT_MS,
        'STREAMS',
        NOTIFICATION_STREAM_KEY,
        '>' // '>' signifie seulement les messages jamais délivrés à ce groupe/consommateur
      )) as RedisStreamReadGroupResult

      if (streamsResult && streamsResult.length > 0 && streamsResult[0][1].length > 0) {
        return streamsResult[0][1]
      }
    } catch (error) {
      logger.error({ err: error, consumer: this.consumerName }, 'Redis XREADGROUP (new messages) failed.')
    }
    return []
  }

  private async claimPendingMessages(): Promise<RedisStreamMessage[]> {
    logger.trace(`Checking for pending messages to claim (idle > ${IDLE_TIMEOUT_BEFORE_CLAIM_MS}ms)...`)
    this.pendingMessageDeliveryCounts.clear() // Nettoyer la map avant chaque tentative de claim

    try {
      // XPENDING <key> <groupname> [IDLE <min-idle-time>] <start> <end> <count> [<consumername>]
      // On ne spécifie pas de consumer pour voir la PEL de tout le groupe
      const pendingSummaryResult: PendingMessageInfo[] | [] = (await redis.xpending(
        NOTIFICATION_STREAM_KEY,
        CONSUMER_GROUP_NAME,
        'IDLE', // Option pour filtrer par temps d'inactivité minimum
        IDLE_TIMEOUT_BEFORE_CLAIM_MS,
        '-', // Début du stream
        '+', // Fin du stream
        MAX_NOTIFS_PER_POLL // Nombre max de messages à inspecter/retourner
      )) as PendingMessageInfo[] | []


      if (!pendingSummaryResult || pendingSummaryResult.length === 0) {
        logger.trace('No suitable pending messages found to claim.')
        return []
      }

      const messagesToClaimDetails: { id: string; deliveryCount: number }[] = []
      for (const msgInfo of pendingSummaryResult) {
        const [messageId, _consumer, _idleTime, deliveryCount] = msgInfo
        messagesToClaimDetails.push({ id: messageId, deliveryCount })
        this.pendingMessageDeliveryCounts.set(messageId, deliveryCount) // Stocker le deliveryCount
      }

      if (messagesToClaimDetails.length === 0) return []
      const messageIdsToClaim = messagesToClaimDetails.map(m => m.id);

      logger.warn(
        `Attempting to claim ${messageIdsToClaim.length} potentially stuck message(s): [${messageIdsToClaim.join(', ')}]`
      )

      // XCLAIM <key> <group> <consumer> <min-idle-time> <ID> [ID ...]
      // On ne spécifie pas JUSTID car on veut les données du message
      const claimedResult = (await redis.xclaim(
        NOTIFICATION_STREAM_KEY,
        CONSUMER_GROUP_NAME,
        this.consumerName,
        IDLE_TIMEOUT_BEFORE_CLAIM_MS, // Seuls les messages inactifs depuis ce temps seront réclamés
        ...messageIdsToClaim
      )) as ClaimedMessagesResult

      if (claimedResult && claimedResult.length > 0) {
        logger.info(`Successfully claimed ${claimedResult.length} message(s).`)
        // Filtrer les messages pour lesquels on n'a pas pu récupérer le delivery count (ne devrait pas arriver)
        // et s'assurer que `pendingMessageDeliveryCounts` est bien à jour pour les messages effectivement réclamés.
        return claimedResult.filter(msg => this.pendingMessageDeliveryCounts.has(msg[0]));
      } else {
        logger.info('No messages were actually claimed (possibly claimed by another worker simultaneously or conditions not met).')
      }
    } catch (error) {
      logger.error({ err: error, consumer: this.consumerName }, 'Error during XPENDING/XCLAIM process.')
    }
    return []
  }

  private async processMessages(messages: RedisStreamMessage[], isClaimed: boolean) {
    logger.info(`Processing ${messages.length} message(s) (${isClaimed ? 'claimed' : 'new'})...`)
    for (const [messageId, fieldsArray] of messages) {
      if (!this.isRunning) {
        logger.info(`Worker shutting down. Halting message processing for ${messageId}.`)
        // Important: NE PAS ACK si on s'arrête. Laisser le message pour un autre claim/traitement.
        break
      }

      const messageData: { [key: string]: string } = {}
      for (let i = 0; i < fieldsArray.length; i += 2) {
        messageData[fieldsArray[i]] = fieldsArray[i + 1]
      }

      let deliveryCount = 1 // Par défaut pour un nouveau message
      if (isClaimed) {
        deliveryCount = this.pendingMessageDeliveryCounts.get(messageId) || 1 // Utiliser le vrai deliveryCount
        if (deliveryCount === 1 && this.pendingMessageDeliveryCounts.has(messageId)) {
          // Si XPENDING a retourné 1, c'est la première *tentative de livraison* pour ce message par le groupe.
          // Si nous le réclamons, c'est qu'il a été assigné à un consumer mais jamais ACK.
          // On peut considérer que c'est au moins la 2e tentative de traitement *effective*.
          // Ou simplement se fier au deliveryCount de Redis. Pour l'instant, on se fie.
        }
        logger.warn({ messageId, consumer: this.consumerName, deliveryCount }, `Processing CLAIMED message (delivery attempt ${deliveryCount} by group).`)
      } else {
        logger.info({ messageId, consumer: this.consumerName }, `Processing NEW message.`)
      }
      // Nettoyer la map pour ce messageId une fois qu'on a récupéré le deliveryCount
      if (isClaimed) this.pendingMessageDeliveryCounts.delete(messageId);


      let shouldAck = false
      let taskResult: SendNotificationResult | null = null

      try {
        taskResult = await this.processNotificationTask(messageData)

        if (taskResult.success) {
          shouldAck = true
          logger.info({ messageId, fcmToken: messageData.fcmToken?.substring(0, 10) + '...', success: true }, `Notification task successful.`)
        } else if (
          taskResult.isTokenInvalid ||
          taskResult.code === 'INVALID_TASK_DATA' || // Erreur de données irrécupérable
          taskResult.code === 'JSON_PARSE_ERROR'
        ) {
          logger.warn(
            { messageId, code: taskResult.code, error: taskResult.error?.message, fcmToken: messageData.fcmToken },
            `Unrecoverable error for message. ACKing to prevent retries.`
          )
          shouldAck = true // ACK pour ne pas retenter une tâche avec des données invalides
        } else {
          // Échec récupérable (ex: erreur réseau FCM, quota, etc.)
          logger.warn(
            { messageId, code: taskResult.code, error: taskResult.error?.message, deliveryCount, maxRetries: MAX_RETRY_BEFORE_DEADLETTER },
            `Recoverable error for message (Attempt ${deliveryCount}). Not ACKing yet.`
          )
          if (deliveryCount >= MAX_RETRY_BEFORE_DEADLETTER) { // Utiliser >=
            logger.error(
              { messageId, code: taskResult.code, deliveryCount },
              `CRITICAL: Max retries (${MAX_RETRY_BEFORE_DEADLETTER}) reached for message. Moving to Dead Letter Queue (simulation) and ACKing.`
            )
            // TODO: Implémenter une vraie Dead Letter Queue (ex: autre stream Redis, table DB)
            // await this.moveToDeadLetterQueue(messageId, messageData, taskResult.error, deliveryCount);
            shouldAck = true // ACK pour le sortir de la PEL principale après tentative de DLQ
          }
        }
      } catch (processingError) { // Erreur inattendue dans processNotificationTask lui-même
        logger.error(
          { err: processingError, messageId },
          '🚨 Unexpected error during processNotificationTask execution.'
        )
        // Ne pas ACK, laisser XCLAIM ou une nouvelle lecture le reprendre si c'est une erreur temporaire.
        // Le deliveryCount augmentera naturellement.
        shouldAck = false
      }


      if (shouldAck) {
        try {
          await redis.xack(NOTIFICATION_STREAM_KEY, CONSUMER_GROUP_NAME, messageId)
          logger.trace(`ACKed message ${messageId}.`)
        } catch (ackError) {
          logger.error({ err: ackError, messageId, consumer: this.consumerName }, 'CRITICAL: Failed to ACK message! This message might be reprocessed.')
          // Ceci est un problème, le message pourrait être traité à nouveau.
        }
      }
    }
  }

  private async processNotificationTask(taskData: {
    [key: string]: string
  }): Promise<SendNotificationResult> {
    const { fcmToken, title, body, data: dataString, notificationType: typeFromStream } = taskData

    if (!fcmToken || !title || !body) {
      logger.error({ taskData }, 'Invalid notification task data (missing fcmToken, title, or body).')
      return { success: false, error: new Error('Invalid task data'), code: 'INVALID_TASK_DATA', isTokenInvalid: !fcmToken }
    }

    let parsedDataFromString: { [key: string]: any } = {}
    if (dataString && dataString !== '{}') {
      try {
        parsedDataFromString = JSON.parse(dataString)
      } catch (parseError) {
        logger.error({ err: parseError, dataString, message: "JSON parse error for 'data' field" }, 'JSON parse error.')
        return { success: false, error: parseError, code: 'JSON_PARSE_ERROR', isTokenInvalid: false }
      }
    }

    // Gestion du 'type' de notification:
    // Priorité 1: 'notificationType' directement du message stream (si RedisHelper l'ajoute)
    // Priorité 2: 'type' à l'intérieur de l'objet 'data' parsé
    // Priorité 3: undefined
    const finalNotificationType = (typeFromStream || parsedDataFromString.type) as NotificationType;

    const finalDataPayload = {
      ...parsedDataFromString, // Les données du JSON string
      // Le type est géré séparément et peut être passé à NotificationHelper si son API le supporte
      // ou inclus dans data si c'est la convention.
      // Pour l'instant, on suppose que NotificationHelper.sendPushNotification ne prend pas 'type' en argument direct,
      // mais qu'il doit être dans le payload 'data'.
    } as { [key: string]: any; type: NotificationType };
    if (finalNotificationType && !finalDataPayload.type) { // S'assurer que `type` est dans data si pas déjà présent
      finalDataPayload.type = finalNotificationType;
    }


    // logger.debug({ fcmToken: fcmToken.substring(0,10)+"...", title, body, data: finalDataPayload }, "Attempting to send push notification.")
    return NotificationHelper.sendPushNotification({
      fcmToken,
      title,
      body,
      data: finalDataPayload, // Contient maintenant le 'type' correctement sourcé
    })
  }


  async cleanupDeadConsumers() {
    logger.warn(
      `Starting cleanup of dead consumers in group ${CONSUMER_GROUP_NAME} (Idle threshold: ${DEAD_CONSUMER_IDLE_THRESHOLD_MS}ms)...`
    )
    try {
      // XINFO CONSUMERS <key> <groupname>
      const consumersInfo = (await redis.xinfo(
        'CONSUMERS',
        NOTIFICATION_STREAM_KEY,
        CONSUMER_GROUP_NAME
      )) as [string, unknown][] | null // Le format est un tableau de [nom_champ, valeur_champ, ...]

      if (!consumersInfo || consumersInfo.length === 0) {
        logger.info('No consumers found in the group to cleanup.')
        return
      }

      let deletedCount = 0
      // La réponse est un tableau plat, il faut le parser en objets
      // [ ['name', 'consumer1', 'pending', 5, 'idle', 123], ['name', 'consumer2', ...] ]
      // Chaque consommateur est un array de paires clé/valeur.
      for (const consumerEntry of consumersInfo) { // Chaque consumerEntry est un tableau de paires
        const consumerData: { [key: string]: any } = {}
        for (let i = 0; i < consumerEntry.length; i += 2) {
          consumerData[consumerEntry[i] as string] = consumerEntry[i + 1];
        }

        const name = consumerData['name'] as string
        const idleTime = Number.parseInt(consumerData['idle'] as string, 10)
        const pendingCount = Number.parseInt(consumerData['pending'] as string, 10)

        if (!name) continue; // Skip si pas de nom (ne devrait pas arriver)

        const isLikelyDead = idleTime > DEAD_CONSUMER_IDLE_THRESHOLD_MS && pendingCount === 0

        if (isLikelyDead) {
          logger.warn(
            `Consumer '${name}' seems dead (idle: ${idleTime}ms, pending: ${pendingCount}). Attempting deletion...`
          )
          try {
            // XGROUP DELCONSUMER <key> <groupname> <consumername>
            await redis.xgroup('DELCONSUMER', NOTIFICATION_STREAM_KEY, CONSUMER_GROUP_NAME, name)
            logger.info(`Successfully deleted potentially dead consumer '${name}'.`)
            deletedCount++
          } catch (delError) {
            logger.error({ err: delError, consumerName: name }, `Failed to delete consumer. It might have messages or was deleted by another process.`)
          }
        } else {
          logger.trace( // Changé en trace pour moins de verbosité
            `Consumer '${name}' considered active (idle: ${idleTime}ms, pending: ${pendingCount}). Skipping cleanup.`
          )
        }
      }
      logger.warn(`Dead consumer cleanup finished. ${deletedCount} consumer(s) potentially deleted.`)
    } catch (error) {
      logger.error({ err: error }, 'Error during dead consumer cleanup process.')
    }
  }

  public async close() { // Peut être appelé par le système de commande Ace si nécessaire
    if (!this.isRunning) return
    logger.info(`👋 Stopping Notification Worker (${this.consumerName}) via close()...`)
    this.isRunning = false
    // Pas d'attente ici, laisser le signal handler gérer la temporisation si l'arrêt vient de là
  }
}