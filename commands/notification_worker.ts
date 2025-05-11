import { BaseCommand, flags } from '@adonisjs/core/ace' // Import 'flags'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import redis from '@adonisjs/redis/services/main'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import NotificationHelper, {
  initializeFirebaseApp,
  type SendNotificationResult,
} from '#services/notification_helper'
import { setTimeout as sleep } from 'node:timers/promises' // Import pour await sleep
import { NotificationType } from '#models/notification'

// --- Configuration ---
const NOTIFICATION_STREAM_KEY = env.get('REDIS_NOTIFICATION_STREAM', 'notifications_queue_stream')
const CONSUMER_GROUP_NAME = env.get(
  'REDIS_NOTIFICATION_CONSUMER_GROUP',
  'notification_workers_group'
)
const WORKER_POLLING_INTERVAL_MS = Number.parseInt(
  process.env.NOTIFICATION_WORKER_POLL_INTERVAL || '1000',
  10
) // Intervalle de polling
const MAX_NOTIFS_PER_POLL = Number.parseInt(process.env.NOTIFICATION_WORKER_MAX_EVENTS || '10', 10) // Moins pour tester les Pels?
const BLOCK_TIMEOUT_MS = Number.parseInt(process.env.NOTIFICATION_WORKER_BLOCK_MS || '5000', 10) // Temps d'attente max pour nouveaux msgs
const IDLE_TIMEOUT_BEFORE_CLAIM_MS = Number.parseInt(
  process.env.NOTIFICATION_WORKER_CLAIM_IDLE_MS || '60000',
  10
) // 1 minute avant de voler un message d'un autre worker
const MAX_RETRY_BEFORE_DEADLETTER = Number.parseInt(
  process.env.NOTIFICATION_WORKER_MAX_RETRY || '5',
  10
) // Nombre max de tentatives avant DLQ

// --- Types Redis (plus précis) ---
type RedisStreamMessageFields = [string, string[]] // [messageId, [field1, value1, ...]]
type RedisStreamReadGroupMessagesResult = [string, RedisStreamMessageFields[]][] | null // [[streamName, [msg1, msg2]], ...] | null
// Format pour XPENDING (simplifié)
type PendingMessageInfo = [string, string, number, number] // [messageId, consumerName, idleTimeMs, deliveryCount]
type PendingMessagesResult = [PendingMessageInfo[], string | null, string | null] | []

export default class NotificationWorker extends BaseCommand {
  public static commandName = 'notification:worker'
  public static description =
    'Robustly listens to Redis Stream and sends push notifications, handles PEL.'

  // Flag pour l'arrêt propre via SIGTERM/SIGINT
  private isRunning = true
  // Nom unique de ce consommateur/worker
  private consumerName: string = `notifworker_${process.pid}_${Date.now().toString(36)}`

  /**
   * Ajoute une option pour lancer le nettoyage des consommateurs morts
   * (--cleanup flag).
   */
  @flags.boolean({
    alias: 'c',
    description: 'Run cleanup for potentially dead consumers in the group',
  })
  declare cleanup: boolean

  public static options: CommandOptions = {
    startApp: true, // L'application est nécessaire
  }
  /**
   * Vérifie si le groupe de consommateurs Redis existe pour le stream,
   * et le crée si nécessaire. Associe le groupe au début du stream ('$').
   * Doit être appelée avant de commencer à lire avec XREADGROUP.
   */
  private async ensureConsumerGroupExists() {
    try {
      // Commande XGROUP CREATE <key> <groupname> <id> [MKSTREAM]
      // - <key>: Nom du stream (NOTIFICATION_STREAM_KEY)
      // - <groupname>: Nom du groupe (CONSUMER_GROUP_NAME)
      // - <id>: '$' signifie que le groupe ne verra que les messages ajoutés APRES sa création.
      //          '0-0' lirait depuis le tout début (rarement voulu pour un worker temps réel).
      //          On utilise '$' pour commencer avec les nouveaux messages.
      // - [MKSTREAM]: Optionnel, crée le stream s'il n'existe pas déjà. Très utile !
      await redis.xgroup('CREATE', NOTIFICATION_STREAM_KEY, CONSUMER_GROUP_NAME, '$', 'MKSTREAM')

      logger.info(
        `Redis Stream consumer group '${CONSUMER_GROUP_NAME}' created or already exists for stream '${NOTIFICATION_STREAM_KEY}'. Starting from new messages ($).`
      )
    } catch (error) {
      // L'erreur la plus commune ici est que le groupe existe déjà.
      if (
        error instanceof Error &&
        error.message.includes('BUSYGROUP Consumer Group name already exists')
      ) {
        logger.info(`Redis Stream consumer group '${CONSUMER_GROUP_NAME}' already exists.`)
        // Ce n'est pas une erreur bloquante, on peut continuer.
      } else {
        // Une autre erreur (connexion Redis? Mauvais nom de stream?) est plus grave.
        logger.error(
          { err: error },
          `Failed to create/ensure consumer group '${CONSUMER_GROUP_NAME}' for stream '${NOTIFICATION_STREAM_KEY}'.`
        )
        // Relancer l'erreur pour que l'appelant (this.initialize) puisse l'attraper et arrêter le worker.
        throw error
      }
    }
  }

  /**
   * Fonction d'initialisation : Initialise Firebase, vérifie groupe Redis.
   */
  private async initialize() {
    initializeFirebaseApp()
    logger.info(`🚀 Notification Worker (${this.consumerName}) starting...`)
    try {
      await this.ensureConsumerGroupExists()
    } catch (groupError) {
      logger.fatal(`Worker (${this.consumerName}) cannot start: ${groupError.message}. Stopping.`)
      throw groupError // Empêche le démarrage
    }
  }

  /**
   * Logique de gestion des signaux d'arrêt (SIGINT, SIGTERM)
   */
  private registerShutdownHandler() {
    const signalHandler = async (signal: string) => {
      logger.info(`Received ${signal}. Shutting down worker (${this.consumerName}) gracefully...`)
      this.isRunning = false
      // Potentiellement attendre un peu ici pour finir les tâches en cours?
      await sleep(3000) // Laisse 3s pour terminer cycle courant
      process.exit(0) // Code 0 = arrêt normal
    }
    process.on('SIGINT', () => signalHandler('SIGINT'))
    process.on('SIGTERM', () => signalHandler('SIGTERM'))
  }

  /**
   * Méthode principale du worker.
   */
  // --- Variables d'état pour l'optimisation ---
  private claimCheckCounter = 0 // Compteur d'itérations depuis le dernier check PEL fructueux
  private claimCheckFrequency = 5 // Vérifie la PEL seulement toutes les 5 itérations de boucle principale si vide
  private lastPelCheckFoundMessages = true // Optimiste au début
  async run() {
    try {
      await this.initialize()
    } catch (initError) {
      this.exitCode = 1
      return
    }
    this.registerShutdownHandler()

    logger.info(`Listening... Claim check frequency: ${this.claimCheckFrequency} loops.`)
    // Boucle principale
    while (this.isRunning) {
      let processedMessagesCount = 0
      try {
        // --- Logique de Claim Optimisée ---
        let claimedMessages: RedisStreamMessageFields[] = []
        // On vérifie la PEL si:
        // - Le compteur atteint la fréquence OU
        // - La dernière fois, on AVAIT trouvé des messages dans la PEL
        if (this.claimCheckCounter >= this.claimCheckFrequency || this.lastPelCheckFoundMessages) {
          this.claimCheckCounter = 0 // Reset compteur
          claimedMessages = await this.claimPendingMessages()
          this.lastPelCheckFoundMessages = claimedMessages.length > 0 // Met à jour l'état
          if (claimedMessages.length > 0) {
            await this.processMessages(claimedMessages, true)
            processedMessagesCount += claimedMessages.length
          }
        } else {
          this.claimCheckCounter++ // Incrémente car on saute le check PEL
          logger.trace(
            `Skipping PEL check (iteration ${this.claimCheckCounter}/${this.claimCheckFrequency})`
          )
        }
        // --- Fin Logique Claim ---

        // --- Lire les Nouveaux Messages (Toujours fait avec BLOCK) ---
        const newMessages = await this.readNewMessages()
        if (newMessages.length > 0) {
          await this.processMessages(newMessages, false)
          processedMessagesCount += newMessages.length
          this.claimCheckCounter = 0 // Reset counter si nouveaux messages traités
          this.lastPelCheckFoundMessages = true // Soyons optimiste pour le prochain cycle PEL
        }
        // --- Fin Lecture Nouveaux Messages ---

        // Pause minimale si aucun message n'a été traité du tout dans ce cycle
        if (processedMessagesCount === 0) {
          await sleep(200) // Petite pause de 200ms si complètement idle
        }
      } catch (error) {
        // Gérer les erreurs majeures dans la boucle (ex: erreur Redis persistante)
        logger.error(
          { err: error },
          '🚨 CRITICAL Error in Worker main loop. Retrying after long pause...'
        )
        if (this.isRunning) await sleep(WORKER_POLLING_INTERVAL_MS * 5) // Pause de 25s avant de réessayer
      }
    } // Fin while

    logger.info(`Notification Worker (${this.consumerName}) loop ended.`)
  } // Fin run

  /**
   * Lit les nouveaux messages du stream pour ce consommateur.
   */
  private async readNewMessages(): Promise<RedisStreamMessageFields[]> {
    try {
      const streamsResult: RedisStreamReadGroupMessagesResult | null = (await redis.xreadgroup(
        'GROUP',
        CONSUMER_GROUP_NAME,
        this.consumerName,
        'COUNT',
        MAX_NOTIFS_PER_POLL,
        'BLOCK',
        BLOCK_TIMEOUT_MS, // Attente bloquante
        'STREAMS',
        NOTIFICATION_STREAM_KEY,
        '>' // Seulement les nouveaux messages
      )) as RedisStreamReadGroupMessagesResult | null
      if (streamsResult && streamsResult.length > 0 && streamsResult[0][1].length > 0) {
        return streamsResult[0][1] // Retourne [[messageId, fields], ...]
      }
    } catch (error) {
      logger.error({ err: error }, 'Redis XREADGROUP (new messages) failed.')
      // Que faire? Pause? Retry? Laisse la boucle principale gérer la pause.
    }
    return [] // Retourne un tableau vide si erreur ou pas de message
  }

  /**
   * Tente de réclamer (voler) des messages en attente d'autres consommateurs potentiellement morts.
   */
  private async claimPendingMessages(): Promise<RedisStreamMessageFields[]> {
    logger.trace('Checking for pending messages to claim...')
    try {
      // 1. Obtenir la liste des messages en attente (PEL) pour tout le groupe
      // '0-0' -> Début du stream, '+' -> Fin du stream (prend toute la PEL)
      // COUNT limite le nombre inspecté à chaque fois
      const pendingSummary: any = await redis.xpending(
        NOTIFICATION_STREAM_KEY,
        CONSUMER_GROUP_NAME,
        'IDLE',
        IDLE_TIMEOUT_BEFORE_CLAIM_MS,
        '-',
        '+',
        MAX_NOTIFS_PER_POLL
      )

      if (!pendingSummary || pendingSummary.length === 0) {
        // Pas de message en attente depuis assez longtemps
        logger.trace('No suitable pending messages found to claim.')
        return []
      }

      // pendingSummary: [ [messageId, consumerName, idleTimeMs, deliveryCount], ... ]
      const messagesToClaim = pendingSummary.map((p: any) => p[0]) // Prend juste les IDs
      if (messagesToClaim.length === 0) return []

      logger.warn(
        `Attempting to claim ${messagesToClaim.length} potentially stuck message(s): [${messagesToClaim.join(', ')}]`
      )

      // 2. Réclamer ces messages pour CE consommateur
      // XCLAIM stream group consumer min-idle-time id [id ...]
      const claimedResult: any = await redis.xclaim(
        NOTIFICATION_STREAM_KEY,
        CONSUMER_GROUP_NAME,
        this.consumerName,
        IDLE_TIMEOUT_BEFORE_CLAIM_MS,
        ...messagesToClaim
        // On pourrait ajouter FORCE ici si on est sûr, ou RETRYCOUNT 0
      )

      // claimedResult: [ [messageId, fields], ... ] des messages effectivement réclamés
      if (claimedResult && claimedResult.length > 0) {
        logger.info(`Successfully claimed ${claimedResult.length} message(s).`)
        return claimedResult
      } else {
        logger.info('No messages were claimed (possibly claimed by another worker simultaneously).')
      }
    } catch (error) {
      logger.error({ err: error }, 'Error during XPENDING/XCLAIM process.')
    }
    return []
  }

  /**
   * Traite une liste de messages (nouveaux ou réclamés).
   * @param messages Liste des messages Redis [ [messageId, fieldsArray], ... ]
   * @param isClaimed Indique si ces messages ont été réclamés (pour logging/retry logic)
   */
  private async processMessages(messages: RedisStreamMessageFields[], isClaimed: boolean) {
    logger.info(`Processing ${messages.length} message(s) (${isClaimed ? 'claimed' : 'new'})...`)
    for (const [messageId, fieldsArray] of messages) {
      // Vérifier si on doit s'arrêter avant de traiter un long message
      if (!this.isRunning) break

      let messageData: { [key: string]: string } = {}
      try {
        for (let i = 0; i < fieldsArray.length; i += 2) {
          messageData[fieldsArray[i]] = fieldsArray[i + 1]
        }
        // Récupérer le nombre de tentatives précédentes si réclamé
        let deliveryCount = 1 // Première livraison par défaut
        if (isClaimed) {
          // Si on avait accès au `deliveryCount` de XPENDING, on l'utiliserait ici.
          // Sinon, on peut essayer de stocker un compteur dans le message lui-même? Ou assumer > 1.
          // Pour l'instant, on assume qu'un message réclamé a déjà échoué au moins une fois.
          deliveryCount = 2 // Estimation basse
          logger.warn(`Processing claimed message ${messageId}.`)
        }

        // Traite la tâche et obtient le résultat détaillé
        const result = await this.processNotificationTask(messageData)

        // Gérer ACK basé sur le résultat ET le nombre de tentatives
        let shouldAck = false
        if (result.success) {
          shouldAck = true
        } else if (
          result.isTokenInvalid ||
          result.code === 'INVALID_TASK_DATA' ||
          result.code === 'JSON_PARSE_ERROR'
        ) {
          logger.warn(
            `Unrecoverable error for message ${messageId} (Code: ${result.code}). ACKing.`
          )
          shouldAck = true
          // On a déjà lancé le nettoyage de token si 'isTokenInvalid'
        } else {
          // Échec récupérable (ex: erreur réseau FCM, quota, etc.)
          deliveryCount++ // Incrémente le compteur de tentatives pour cette instance (limité)
          logger.warn(
            `Recoverable error for message ${messageId} (Code: ${result.code}, Attempt: ${deliveryCount}). Not ACKing yet.`
          )
          if (deliveryCount > MAX_RETRY_BEFORE_DEADLETTER) {
            logger.error(
              `CRITICAL: Max retries (${MAX_RETRY_BEFORE_DEADLETTER}) reached for message ${messageId}. Moving to Dead Letter Queue (simulation) and ACKing.`
            )
            // TODO: Implémenter une vraie Dead Letter Queue (ex: autre stream Redis, table DB)
            // await this.moveToDeadLetterQueue(messageId, messageData, result.error);
            shouldAck = true // ACK pour le sortir de la PEL principale après DLQ
          }
        }

        // Acknowledge si nécessaire
        if (shouldAck) {
          try {
            await redis.xack(NOTIFICATION_STREAM_KEY, CONSUMER_GROUP_NAME, messageId)
            logger.trace(`ACKed message ${messageId}.`)
          } catch (ackError) {
            logger.error({ err: ackError, messageId }, 'CRITICAL: Failed to ACK message!')
          }
        }
      } catch (processingError) {
        logger.error(
          { err: processingError, messageId },
          '🚨 Unexpected error processing message loop.'
        )
        // Ne pas ACK si erreur inattendue, laissons XCLAIM le reprendre.
      }
    } // Fin boucle for messages
  }

  /**
   * Traite la logique d'envoi pour une seule tâche/message.
   */
  private async processNotificationTask(taskData: {
    [key: string]: string
  }): Promise<SendNotificationResult> {
    const { fcmToken, title, body, data: dataString, type } = taskData

    if (!fcmToken || !title || !body) {
      logger.error({ taskData }, 'Invalid notification task data.')
      return {
        success: false,
        error: new Error('Invalid task data'),
        code: 'INVALID_TASK_DATA',
        isTokenInvalid: true,
      } // ACK car data mauvaise
    }
    let dataPayload: { [key: string]: any } | undefined
    try {
      if (dataString && dataString !== '{}') dataPayload = JSON.parse(dataString)
    } catch (parseError) {
      logger.error({ err: parseError, dataString }, 'JSON parse error.')
      return { success: false, error: parseError, code: 'JSON_PARSE_ERROR', isTokenInvalid: true } // ACK car data mauvaise
    }

    const result = await NotificationHelper.sendPushNotification({
      fcmToken,
      title,
      body,
      data: dataPayload || {},
      type: type as NotificationType,
    })
    return result
  }

  /**
   * Supprime les consommateurs inactifs et sans messages pendants du groupe.
   * À lancer manuellement avec --cleanup ou périodiquement par un job séparé.
   */
  async cleanupDeadConsumers() {
    // Augmentation du seuil IDLE et ajout d'une marge (ex: 10 minutes)
    const DEAD_CONSUMER_IDLE_THRESHOLD_MS = Math.max(
      IDLE_TIMEOUT_BEFORE_CLAIM_MS * 20,
      10 * 60 * 1000
    )

    logger.warn(
      `Starting cleanup of dead consumers in group ${CONSUMER_GROUP_NAME} (Idle threshold: ${DEAD_CONSUMER_IDLE_THRESHOLD_MS}ms)...`
    )
    try {
      const consumers = (await redis.xinfo(
        'CONSUMERS',
        NOTIFICATION_STREAM_KEY,
        CONSUMER_GROUP_NAME
      )) as any[]
      if (!consumers || consumers.length === 0) {
        logger.info('No consumers found in the group.')
        return
      }

      let deletedCount = 0
      for (const consumerInfo of consumers) {
        let consumerData: { [key: string]: any } = {}
        for (let i = 0; i < consumerInfo.length; i += 2)
          consumerData[consumerInfo[i]] = consumerInfo[i + 1]

        const name = consumerData['name']
        const idleTime = Number.parseInt(consumerData['idle'], 10)
        const pendingCount = Number.parseInt(consumerData['pending'], 10)

        // --- NOUVEAU CRITÈRE ---
        // Est considéré mort si :
        // 1. Inactif depuis TRÈS longtemps ET
        // 2. N'a PLUS aucun message en attente (un autre worker les a sûrement réclamés via XCLAIM)
        const isLikelyDead = idleTime > DEAD_CONSUMER_IDLE_THRESHOLD_MS && pendingCount === 0
        // -----------------------

        if (isLikelyDead) {
          logger.warn(
            `Consumer '${name}' seems dead (idle: ${idleTime}ms, pending: ${pendingCount}). Attempting deletion...`
          )
          try {
            await redis.xgroup('DELCONSUMER', NOTIFICATION_STREAM_KEY, CONSUMER_GROUP_NAME, name)
            logger.info(`Successfully deleted dead consumer '${name}'.`)
            deletedCount++
          } catch (delError) {
            logger.error({ err: delError, consumerName: name }, `Failed to delete consumer.`)
          }
        } else {
          logger.info(
            `Consumer '${name}' seems active (idle: ${idleTime}ms, pending: ${pendingCount}). Skipping cleanup.`
          )
        }
      }
      logger.warn(`Dead consumer cleanup finished. ${deletedCount} consumer(s) deleted.`)
    } catch (error) {
      logger.error({ err: error }, 'Error during dead consumer cleanup.')
    }
  } // Fin cleanupDeadConsumers

  /** Arrêt propre */
  public async close() {
    this.isRunning = false
    logger.info(`👋 Stopping Notification Worker (${this.consumerName})...`)
  }
}
