// app/services/payment_service.ts
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db' // Pour les transactions si nécessaire pour les mises à jour
import OrderTransaction, {
    OrderTransactionStatus,
    PaymentMethod,
    OrderTransactionType, // Pour vérification
} from '#models/order_transaction'
import Driver from '#models/driver' // Pourrait être utile pour des infos supplémentaires
import { DateTime } from 'luxon'

// --- Interfaces pour les adaptateurs de passerelle (Exemple) ---
interface PaymentGatewayAdapter {
    initiatePayment(payload: GatewayPaymentPayload): Promise<GatewayPaymentResult>
    checkPaymentStatus?(transactionReference: string): Promise<GatewayPaymentStatusResult> // Optionnel
}

interface GatewayPaymentPayload {
    amount: number
    currency: string
    recipientMobileNumber: string // Formaté pour la passerelle
    recipientProvider: PaymentMethod // 'mtn', 'orange', etc.
    orderId?: string // Pour référence chez la passerelle
    transactionId: string // Notre ID de transaction interne pour le rapprochement
    description?: string
    // ... autres champs spécifiques à la passerelle
}

interface GatewayPaymentResult {
    success: boolean
    gatewayTransactionId?: string // ID de transaction de la passerelle
    status: 'PENDING' | 'SUCCESSFUL' | 'FAILED' | 'UNKNOWN' // Statut retourné par la passerelle
    message?: string
    errorCode?: string
    rawResponse?: any // Réponse brute pour débogage
}

interface GatewayPaymentStatusResult extends GatewayPaymentResult { } // Similaire pour la vérification de statut

// --- Adaptateurs de Passerelle (Simulés) ---
// Dans une vraie application, vous auriez des classes/modules séparés pour chaque passerelle.
class MtnGatewayAdapter implements PaymentGatewayAdapter {
    async initiatePayment(payload: GatewayPaymentPayload): Promise<GatewayPaymentResult> {
        logger.info({ provider: 'MTN', ...payload }, 'Simulating MTN payment initiation...')
        // TODO: Intégrer le SDK/API MTN ici
        // Simuler une réponse
        await new Promise(resolve => setTimeout(resolve, 1500)); // Simuler latence réseau
        const isSuccess = Math.random() > 0.2; // 80% de succès
        if (isSuccess) {
            return {
                success: true,
                gatewayTransactionId: `mtn_tx_${Date.now()}`,
                status: 'SUCCESSFUL',
                message: 'MTN Payment successful (simulation)',
            }
        } else {
            return {
                success: false,
                status: 'FAILED',
                message: 'MTN Payment failed (simulation)',
                errorCode: 'MTN_ERR_SIM_001',
            }
        }
    }
}

class OrangeGatewayAdapter implements PaymentGatewayAdapter {
    async initiatePayment(payload: GatewayPaymentPayload): Promise<GatewayPaymentResult> {
        logger.info({ provider: 'Orange', ...payload }, 'Simulating Orange payment initiation...')
        // TODO: Intégrer le SDK/API Orange ici
        await new Promise(resolve => setTimeout(resolve, 1000));
        return {
            success: true, // Supposons qu'Orange réussit toujours pour la démo
            gatewayTransactionId: `orange_tx_${Date.now()}`,
            status: 'SUCCESSFUL',
            message: 'Orange Payment successful (simulation)',
        }
    }
}

class WaveGatewayAdapter implements PaymentGatewayAdapter {
    async initiatePayment(payload: GatewayPaymentPayload): Promise<GatewayPaymentResult> {
        logger.info({ provider: 'Wave', ...payload }, 'Simulating Wave payment initiation...')
        // TODO: Intégrer le SDK/API Wave ici
        await new Promise(resolve => setTimeout(resolve, 1000));
        return {
            success: true, // Supposons qu'Orange réussit toujours pour la démo
            gatewayTransactionId: `wave_tx_${Date.now()}`,
            status: 'SUCCESSFUL',
            message: 'Wave Payment successful (simulation)',
        }
    }
}
// Ajouter WaveGatewayAdapter, etc.

class PaymentService {
    private gatewayAdapters: Map<PaymentMethod, PaymentGatewayAdapter>

    constructor() {
        this.gatewayAdapters = new Map()
        this.gatewayAdapters.set(PaymentMethod.MTN, new MtnGatewayAdapter())
        this.gatewayAdapters.set(PaymentMethod.ORANGE, new OrangeGatewayAdapter())
        this.gatewayAdapters.set(PaymentMethod.WAVE, new WaveGatewayAdapter());
        // ... initialiser les autres adaptateurs
    }

    /**
     * Initiates the payout process for a driver for a given OrderTransaction.
     * This method is called by BillingWorker after creating an OrderTransaction with PENDING status.
     * It will attempt the payment and update the OrderTransaction status accordingly.
     *
     * IMPORTANT: This simplified version makes a direct call to the gateway and updates.
     * In a robust system, this might:
     * 1. Enqueue a job for a separate "PaymentExecutionWorker".
     * 2. Handle webhooks from the payment gateway to update status asynchronously.
     * 3. Implement retry logic with backoff for temporary gateway failures.
     */
    public async initiateDriverPayout(
        orderTransactionId: string,
        // Les infos de paiement pourraient aussi être récupérées depuis la DB via orderTransactionId
        // mais les passer peut éviter une lecture si BillingWorker les a déjà.
        paymentMethodDetail: { provider: PaymentMethod, number: string },
        amountToPay: number
    ): Promise<void> {
        const logContext = { orderTransactionId, service: 'PaymentService' }
        logger.info(logContext, `Initiating driver payout process...`)

        let orderTransaction: OrderTransaction | null = null

        try {
            orderTransaction = await OrderTransaction.find(orderTransactionId)

            if (!orderTransaction) {
                logger.error({ ...logContext }, `OrderTransaction not found. Cannot proceed with payment.`)
                return
            }

            if (orderTransaction.status !== OrderTransactionStatus.PENDING) {
                logger.warn(
                    { ...logContext, currentStatus: orderTransaction.status },
                    `OrderTransaction is not in PENDING status. Skipping payment initiation.`
                )
                // Pourrait être un appel en double, ou déjà traité.
                return
            }

            if (orderTransaction.type !== OrderTransactionType.DRIVER_PAYMENT) {
                logger.error(
                    { ...logContext, type: orderTransaction.type },
                    `OrderTransaction is not of type DRIVER_PAYMENT. Aborting.`
                )
                // Mettre à jour en FAILED ? Ou juste ignorer ?
                orderTransaction.status = OrderTransactionStatus.FAILED
                orderTransaction.history_status.push({ status: OrderTransactionStatus.FAILED, timestamp: DateTime.now().toISO() })
                orderTransaction.metadata = { ...orderTransaction.metadata, reason: 'Incorrect transaction type for payout' }
                await orderTransaction.save()
                return
            }

            // Récupérer le Driver pour le numéro de téléphone (si pas déjà dans OrderTransaction.payment_method ou metadata)
            // Ici, on suppose que OrderTransaction.payment_method est le provider (MTN, Orange)
            // et on a besoin du numéro du chauffeur pour ce provider.
            // `activePaymentMethod.number` passé par BillingWorker contient déjà cela.
            // Pour cet exemple, on va supposer que BillingWorker a bien passé le numéro.
            // Si on veut le récupérer ici :
            const driver = await Driver.find(orderTransaction.driver_id)
            if (!driver || !driver.mobile_money) {
                logger.error({ ...logContext, driverId: orderTransaction.driver_id }, "Driver or mobile money info not found for transaction.")
                orderTransaction.status = OrderTransactionStatus.FAILED
                orderTransaction.history_status.push({ status: OrderTransactionStatus.FAILED, timestamp: DateTime.now().toISO() })
                orderTransaction.metadata = { ...orderTransaction.metadata, reason: 'Driver or mobile_money info missing' }
                await orderTransaction.save()
                return
            }

            const paymentMethodInfo = driver.mobile_money.find(pm => pm.number === orderTransaction?.payment_method && pm.status === 'active')
            if (!paymentMethodInfo) {
                logger.error({ ...logContext, paymentMethod: orderTransaction?.payment_method }, "Specified payment method not found or inactive for driver.")
                orderTransaction.status = OrderTransactionStatus.FAILED
                orderTransaction.history_status.push({ status: OrderTransactionStatus.FAILED, timestamp: DateTime.now().toISO() })
                orderTransaction.metadata = { ...orderTransaction?.metadata, reason: `Payment method ${orderTransaction?.payment_method} not active/found` }
                await orderTransaction.save()
                return
            }
            // Le champ `payment_method` dans OrderTransaction stocke déjà le numéro spécifique du compte mobile money (ex: 'mtn_NUMERO')
            // Il faut en extraire le provider (mtn, orange) et le numéro.
            // Pour simplifier, supposons que `orderTransaction.payment_method` est juste le provider pour l'instant (ex: PaymentMethod.MTN)
            // et que `paymentMethodInfo.number` est le numéro de téléphone.

            const adapter = this.gatewayAdapters.get(orderTransaction.payment_method as PaymentMethod) // Le cast est nécessaire si le type est string
            if (!adapter) {
                logger.error(
                    { ...logContext, paymentMethod: orderTransaction.payment_method },
                    `No payment gateway adapter found for method: ${orderTransaction.payment_method}`
                )
                orderTransaction.status = OrderTransactionStatus.FAILED
                orderTransaction.history_status.push({ status: OrderTransactionStatus.FAILED, timestamp: DateTime.now().toISO() })
                orderTransaction.metadata = { ...orderTransaction?.metadata, reason: 'Unsupported payment method' }
                await orderTransaction.save()
                return
            }

            // Préparer le payload pour la passerelle
            const gatewayPayload: GatewayPaymentPayload = {
                amount: orderTransaction.amount,
                currency: orderTransaction.currency,
                // Le champ payment_method de OrderTransaction devrait contenir le numéro spécifique.
                // Ex: '07xxxxxxxx' si c'est un numéro direct, ou un identifiant spécifique.
                // Pour cet exemple, utilisons `paymentMethodInfo.number` qui est le numéro de téléphone mobile money.
                recipientMobileNumber: paymentMethodInfo.number, // C'est le numéro de téléphone, pas l'enum PaymentMethod
                recipientProvider: orderTransaction.payment_method as PaymentMethod,
                orderId: orderTransaction.order_id || undefined,
                transactionId: orderTransaction.id, // Notre ID interne pour rapprochement
                description: `Payment for order ${orderTransaction.order_id}`,
            }

            logger.info({ ...logContext, payload: gatewayPayload }, `Attempting payment via gateway adapter.`)
            const gatewayResult = await adapter.initiatePayment(gatewayPayload)

            // Mettre à jour OrderTransaction en fonction de la réponse de la passerelle
            orderTransaction.transaction_reference = gatewayResult.gatewayTransactionId || orderTransaction.transaction_reference // Conserver l'ancien si pas de nouveau
            orderTransaction.metadata = {
                ...orderTransaction.metadata,
                gateway_response_message: gatewayResult.message,
                gateway_error_code: gatewayResult.errorCode,
                gateway_raw_response_snippet: gatewayResult.rawResponse ? JSON.stringify(gatewayResult.rawResponse).substring(0, 200) : undefined,
            }

            if (gatewayResult.success && gatewayResult.status === 'SUCCESSFUL') {
                orderTransaction.status = OrderTransactionStatus.SUCCESS
                orderTransaction.payment_date = DateTime.now()
                logger.info(
                    { ...logContext, gatewayId: gatewayResult.gatewayTransactionId },
                    `Payment successful.`
                )
            } else if (gatewayResult.status === 'PENDING') {
                // La passerelle a accepté la requête mais le paiement est en attente de confirmation
                // Laisser le statut PENDING. Un webhook ou un job de vérification mettra à jour plus tard.
                orderTransaction.status = OrderTransactionStatus.PENDING // Reste PENDING
                logger.warn(
                    { ...logContext, gatewayId: gatewayResult.gatewayTransactionId, gatewayStatus: gatewayResult.status },
                    `Payment is PENDING at gateway. Awaiting asynchronous confirmation.`
                )
            }

            else { // Échec ou statut inconnu de la passerelle
                orderTransaction.status = OrderTransactionStatus.FAILED
                logger.error(
                    { ...logContext, gatewayMessage: gatewayResult.message, gatewayCode: gatewayResult.errorCode },
                    `Payment failed at gateway.`
                )
            }
            orderTransaction.history_status.push({ status: orderTransaction.status, timestamp: DateTime.now().toISO() })
            await orderTransaction.save()

        } catch (error) {
            logger.error({ err: error, ...logContext }, `CRITICAL error during payment initiation or update.`)
            // Si une OrderTransaction a été chargée et que l'erreur survient APRES l'appel à la passerelle
            // mais AVANT orderTransaction.save(), la transaction DB pourrait rester PENDING.
            // Il faut une stratégie de reprise pour les transactions PENDING.
            if (orderTransaction && orderTransaction.status === OrderTransactionStatus.PENDING) {
                try {
                    orderTransaction.status = OrderTransactionStatus.FAILED // Marquer comme FAILED en cas d'erreur interne
                    orderTransaction.history_status.push({ status: OrderTransactionStatus.FAILED, timestamp: DateTime.now().toISO() })
                    orderTransaction.metadata = { ...orderTransaction.metadata, reason: `Internal error during payment processing: ${error.message}` }
                    await orderTransaction.save()
                    logger.info({ ...logContext }, "OrderTransaction marked as FAILED due to internal error after gateway call.")
                } catch (saveError) {
                    logger.error({ err: saveError, ...logContext }, "Failed to even mark OrderTransaction as FAILED after internal error.")
                }
            }
        }
    }

    /**
     * (Optionnel) Méthode pour vérifier le statut d'une transaction PENDING auprès de la passerelle.
     * Pourrait être appelée par un worker de vérification de statut.
     */
    public async checkAndUpdatePendingTransaction(orderTransactionId: string): Promise<void> {
        const orderTransaction = await OrderTransaction.find(orderTransactionId);
        if (!orderTransaction || orderTransaction.status !== OrderTransactionStatus.PENDING || !orderTransaction.transaction_reference) {
            logger.trace({ orderTransactionId, status: orderTransaction?.status }, "Skipping status check: not pending or no gateway reference.");
            return;
        }

        const adapter = this.gatewayAdapters.get(orderTransaction.payment_method as PaymentMethod);
        if (!adapter || !adapter.checkPaymentStatus) {
            logger.warn({ orderTransactionId, method: orderTransaction.payment_method }, "No adapter or status check method for payment.");
            return;
        }

        try {
            logger.info({ orderTransactionId, ref: orderTransaction.transaction_reference }, "Checking payment status with gateway.");
            const statusResult = await adapter.checkPaymentStatus(orderTransaction.transaction_reference);

            // Logique de mise à jour similaire à initiateDriverPayout après l'appel gatewayResult
            if (statusResult.success && statusResult.status === 'SUCCESSFUL') {
                orderTransaction.status = OrderTransactionStatus.SUCCESS;
                orderTransaction.payment_date = DateTime.now();
                // ... mettre à jour metadata ...
            } else if (statusResult.status === 'FAILED') {
                orderTransaction.status = OrderTransactionStatus.FAILED;
                // ... mettre à jour metadata ...
            } else {
                // Reste PENDING ou autre statut géré par la passerelle
            }
            orderTransaction.history_status.push({ status: orderTransaction.status, timestamp: DateTime.now().toISO() });
            await orderTransaction.save();
            logger.info({ orderTransactionId, newStatus: orderTransaction.status }, "Payment status checked and updated.");

        } catch (error) {
            logger.error({ err: error, orderTransactionId }, "Error checking payment status.");
        }
    }

}

export default new PaymentService()