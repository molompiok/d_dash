// app/commands/billing_worker.ts
import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import redis from '@adonisjs/redis/services/main'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import env from '#start/env'
import { MissionLifecycleEvent, type MissionCompletedData } from '#services/redis_helper'
import Order from '#models/order'
import Driver from '#models/driver' // Import Driver
import OrderTransaction, {
    OrderTransactionStatus,
    OrderTransactionType,
    PaymentMethod, // Importer si PaymentService en a besoin directement
} from '#models/order_transaction'
import payment_service from '#services/payment_service'
import { DateTime } from 'luxon'

type RedisStreamMessage = [string, string[]] // [messageId, [field1, value1, ...]]
type RedisStreamReadGroupResult = [string, RedisStreamMessage[]][] | null // 

const ASSIGNMENT_EVENTS_STREAM_KEY = env.get(
    'REDIS_ASSIGNMENT_LOGIC_STREAM',
    'assignment_events_stream'
)
const CONSUMER_GROUP_NAME = env.get('REDIS_BILLING_CONSUMER_GROUP', 'billing_worker_group')
const WORKER_NAME_PREFIX = 'billing_worker'
const POLLING_INTERVAL_MS = env.get('BILLING_WORKER_POLL_INTERVAL', 5000)
const MAX_EVENTS_PER_POLL = env.get('BILLING_WORKER_MAX_EVENTS', 10)

export default class BillingWorker extends BaseCommand {
    public static commandName = 'billing:worker'
    public static description = 'Processes completed missions for driver payments.'

    private consumerName: string = `${WORKER_NAME_PREFIX}_${process.pid}_${Date.now().toString(36)}`
    private isRunning = true

    public static options: CommandOptions = { startApp: true }

    private async ensureConsumerGroupExists() {
        try {
            await redis.xgroup('CREATE', ASSIGNMENT_EVENTS_STREAM_KEY, CONSUMER_GROUP_NAME, '$', 'MKSTREAM')
            logger.info(
                `Consumer group '${CONSUMER_GROUP_NAME}' created or already exists for stream '${ASSIGNMENT_EVENTS_STREAM_KEY}'.`
            )
        } catch (error: any) {
            if (error.message && error.message.includes('BUSYGROUP')) {
                logger.info(`Consumer group '${CONSUMER_GROUP_NAME}' already exists.`)
            } else {
                logger.error({ err: error }, 'Failed to create/ensure consumer group.')
                throw error // Arrêter le worker si le groupe ne peut pas être assuré
            }
        }
    }

    private registerShutdownHandler() {
        const handler = async (signal: string) => {
            if (!this.isRunning) return
            logger.info(`Received ${signal}. Billing Worker (${this.consumerName}) shutting down...`)
            this.isRunning = false
            // Donner un peu de temps à la boucle XREAD de se terminer
            await new Promise(resolve => setTimeout(resolve, Math.min(POLLING_INTERVAL_MS + 500, 3000)));
            logger.info(`👋 Billing Worker (${this.consumerName}) stopped.`)
            process.exit(0)
        }
        process.on('SIGINT', () => handler('SIGINT'))
        process.on('SIGTERM', () => handler('SIGTERM'))
    }

    async run() {
        logger.info(`🚀 Billing Worker (${this.consumerName}) starting... Stream: ${ASSIGNMENT_EVENTS_STREAM_KEY}, Group: ${CONSUMER_GROUP_NAME}`)
        try {
            await this.ensureConsumerGroupExists()
        } catch (initError) {
            this.exitCode = 1
            return
        }
        this.registerShutdownHandler()

        while (this.isRunning) {
            try {
                const streamsResult = (await redis.xreadgroup(
                    'GROUP',
                    CONSUMER_GROUP_NAME,
                    this.consumerName,
                    'COUNT',
                    MAX_EVENTS_PER_POLL,
                    'BLOCK',
                    POLLING_INTERVAL_MS,
                    'STREAMS',
                    ASSIGNMENT_EVENTS_STREAM_KEY,
                    '>' // Lire les messages en attente pour ce consommateur dans ce groupe
                )) as RedisStreamReadGroupResult

                if (streamsResult && streamsResult.length > 0 && streamsResult[0][1].length > 0) {
                    const messages = streamsResult[0][1]
                    for (const [messageId, fieldsArray] of messages) {
                        if (!this.isRunning) break

                        const parsedMessage: { [key: string]: string } = {}
                        for (let i = 0; i < fieldsArray.length; i += 2) {
                            parsedMessage[fieldsArray[i]] = fieldsArray[i + 1]
                        }

                        // Filtrer uniquement les événements de complétion de mission
                        if (parsedMessage.type === MissionLifecycleEvent.COMPLETED) {
                            await this.processCompletedMission(parsedMessage as any as MissionCompletedData, messageId)
                        } else {
                            // Pour les autres types d'événements, ce worker n'est pas concerné.
                            // On ACK pour les retirer de sa file d'attente spécifique.
                            logger.trace({ type: parsedMessage.type, messageId }, "Ignoring event type not relevant for billing worker, ACKing.")
                            await redis.xack(ASSIGNMENT_EVENTS_STREAM_KEY, CONSUMER_GROUP_NAME, messageId)
                        }
                    }
                }
                // Pas besoin de sleep explicite ici car XREADGROUP avec BLOCK gère l'attente
            } catch (error) {
                logger.error({ err: error, consumer: this.consumerName }, '🚨 Error in Billing Worker main loop. Retrying after pause...')
                if (this.isRunning) await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS * 2))
            }
        }
        logger.info(`Billing Worker (${this.consumerName}) loop ended.`)
    }

    async processCompletedMission(eventData: MissionCompletedData, messageId: string) {
        const { orderId, driverId, finalRemuneration, timestamp } = eventData
        const logContext = { orderId, driverId, finalRemuneration, messageId, eventTimestamp: timestamp }
        logger.info(logContext, `Processing completed mission for payment.`)

        let orderTransaction: OrderTransaction | null = null
        const trx = await db.transaction() // Transaction pour la création de OrderTransaction

        try {
            // 1. Vérification d'idempotence : la mission a-t-elle déjà une transaction de paiement réussie ou en attente ?
            const existingTransaction = await OrderTransaction.query({ client: trx })
                .where('order_id', orderId)
                .where('driver_id', driverId)
                .where('type', OrderTransactionType.DRIVER_PAYMENT)
                .whereIn('status', [OrderTransactionStatus.PENDING, OrderTransactionStatus.SUCCESS])
                .first()

            if (existingTransaction) {
                logger.warn(
                    { ...logContext, transactionId: existingTransaction.id, status: existingTransaction.status },
                    `Payment transaction already exists for this completed mission. ACKing message.`
                )
                await trx.commit() // Commit la transaction vide (ou rollback, peu importe car rien n'a été fait)
                await redis.xack(ASSIGNMENT_EVENTS_STREAM_KEY, CONSUMER_GROUP_NAME, messageId)
                return
            }

            // 2. Récupérer les informations nécessaires (Order pour currency et company_id)
            const order = await Order.query({ client: trx }) // Utiliser la transaction pour la lecture aussi
                .where('id', orderId)
                .preload('company') // Si Order.company_id est l'ID du modèle Company qui a user_id
                .first()

            if (!order) {
                logger.error({ ...logContext }, `Order not found. Cannot process payment. ACKing to avoid retries.`)
                await trx.commit()
                await redis.xack(ASSIGNMENT_EVENTS_STREAM_KEY, CONSUMER_GROUP_NAME, messageId)
                return
            }

            // Récupérer le driver pour ses infos de paiement (mobile_money)
            const driver = await Driver.query({ client: trx }).where('id', driverId).first()
            if (!driver || !driver.mobile_money || driver.mobile_money.length === 0) {
                logger.error({ ...logContext, driverId }, `Driver or driver payment methods not found. Cannot process payment. ACKing.`)
                await trx.commit()
                await redis.xack(ASSIGNMENT_EVENTS_STREAM_KEY, CONSUMER_GROUP_NAME, messageId)
                return
            }

            // Sélectionner une méthode de paiement active du chauffeur
            const activePaymentMethod = driver.mobile_money.find(pm => pm.status === 'active')!
            if (!activePaymentMethod) {
                logger.error({ ...logContext, driverId }, `Driver has no active payment methods. Cannot process payment. ACKing.`)
                await trx.commit()
                await redis.xack(ASSIGNMENT_EVENTS_STREAM_KEY, CONSUMER_GROUP_NAME, messageId)
                return
            }


            // 3. Créer l'enregistrement OrderTransaction avec statut PENDING
            // Le company_id de la transaction est celui de l'entreprise qui a passé la commande
            // On suppose que order.company_id est l'ID de l'entreprise.
            // Si order.company est un modèle Company qui a un user_id: const orderInitiatorCompanyId = order.company.user_id;
            // Pour l'instant, on suppose que order.company_id est l'ID de l'entreprise.
            const orderInitiatorCompanyId = order.company_id;


            orderTransaction = await OrderTransaction.create(
                {
                    driver_id: driverId,
                    order_id: orderId,
                    currency: order.currency, // Ou une devise par défaut pour les paiements chauffeurs
                    company_id: orderInitiatorCompanyId, // L'ID de l'entreprise qui a initié la commande
                    type: OrderTransactionType.DRIVER_PAYMENT,
                    payment_method: activePaymentMethod.number as PaymentMethod, // Ex: 'mtn', 'orange'
                    amount: parseFloat(finalRemuneration as any), // S'assurer que c'est un nombre
                    status: OrderTransactionStatus.PENDING,
                    history_status: [{ status: OrderTransactionStatus.PENDING, timestamp: DateTime.now().toISO() }],
                    // transaction_reference sera mis à jour par PaymentService
                },
                { client: trx }
            )

            logger.info(
                { ...logContext, transactionId: orderTransaction.id },
                `OrderTransaction record created with PENDING status.`
            )

            // Tout est bon pour la création de la transaction, on commit.
            await trx.commit()

            // 4. Appeler PaymentService pour initier le paiement réel (en dehors de la transaction DB initiale)
            // On passe l'ID de la transaction que PaymentService mettra à jour.
            // Cette opération est asynchrone et ne bloque pas l'ACK du message Redis.
            // La mise à jour du statut de la transaction (SUCCESS/FAILED) sera gérée par PaymentService
            // (potentiellement via des webhooks ou un autre worker qui vérifie les statuts).
            //@ts-ignore
            payment_service.initiateDriverPayout(orderTransaction.id, activePaymentMethod, parseFloat(finalRemuneration as any))
                .then(() => {
                    logger.info({ transactionId: orderTransaction!.id }, "PaymentService.initiateDriverPayout called successfully (async).")
                })
                .catch(payoutError => {
                    logger.error({ err: payoutError, transactionId: orderTransaction!.id }, "Error calling PaymentService.initiateDriverPayout (async). Transaction remains PENDING.")
                    // Ici, la transaction est PENDING. Un mécanisme de retry/vérification pour les transactions PENDING est nécessaire.
                })

            // 5. ACK le message Redis car la transaction PENDING a été créée.
            // Le succès ou l'échec du paiement réel est un processus séparé.
            await redis.xack(ASSIGNMENT_EVENTS_STREAM_KEY, CONSUMER_GROUP_NAME, messageId)
            logger.info({ ...logContext, transactionId: orderTransaction.id }, `Successfully processed completed mission event and initiated payment flow. Message ACKed.`)

        } catch (error) {
            if (!trx.isCompleted) {
                await trx.rollback()
            }
            logger.error({ err: error, ...logContext }, `CRITICAL error processing completed mission. Transaction rolled back. Message NOT ACKed.`)
            // Ne pas ACK si la création de la transaction initiale échoue, pour permettre une nouvelle tentative.
            // Attention: si l'erreur vient d'une donnée invalide dans l'événement, cela pourrait causer une boucle.
            // Une logique de "dead letter" pour les messages du stream après N échecs serait utile ici aussi.
        }
    }
    // ... autres méthodes (close, etc.)
}