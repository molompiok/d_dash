// app/controllers/sse/order_tracking_controller.ts
import { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import emitter from '@adonisjs/core/services/emitter'
import logger from '@adonisjs/core/services/logger'
import Order from '#models/order'
import { OrderStatus } from '#models/order'
import { cuid } from '@adonisjs/core/helpers'
import { DriverLocationUpdatePayload, OrderStatusUpdatePayload } from '../../contracts/events.js'
// --- Assurer l'import des types de Payload ---

// --- Configuration (depuis env ou fichier config) ---
// Timeout en ms pour fermer les connexions inactives (ex: 15 minutes)
const SSE_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000
// Intervalle en ms pour envoyer un 'ping' keep-alive (ex: 30 secondes)
const SSE_PING_INTERVAL_MS = 30 * 1000
// ------------------------------------------------------

/**
 * Garde une trace des timers de timeout pour chaque connexion
 * Clef: Identifiant unique de connexion (pourrait être req.id généré par Adonis ou un cuid())
 * Valeur: NodeJS.Timeout
 */
const connectionTimeouts = new Map<string, NodeJS.Timeout>()
/**
 * Garde une trace des timers de ping pour chaque connexion
 */
const connectionPings = new Map<string, NodeJS.Timeout>()

@inject()
export default class OrderTrackingController {
  /**
   * Gère la connexion SSE pour le suivi d'une commande.
   * Optimisations : sélection de champs, timeout, ping.
   * GET /track-stream/:id
   */
  async stream({ request, response, params, auth }: HttpContext) {
    const orderId = params.id
    const connectionId = request.id() || cuid() // Utilise l'ID requête ou génère un ID unique

    logger.info(`SSE connection attempt for Order ${orderId} [ConnId: ${connectionId}]`)

    // --- Vérification d'Autorisation/Existence ---
    try {
      // Requête optimisée juste pour vérifier l'existence et potentiellement le propriétaire
      // Adapté ici pour vérifier si la commande existe simplement
      const orderCheck = await Order.query()
        .select('id') // Ne sélectionne que l'ID
        .where('id', orderId)
        // -- Si le suivi est PRIVÉ, ajouter la clause 'andWhere' : --
        // .andWhere('company_id', user.company?.id) // Vérification propriétaire
        .first()

      if (!orderCheck) {
        logger.warn(`SSE: Order ${orderId} not found [ConnId: ${connectionId}]`)
        return response.notFound({ message: 'Commande non trouvée.' })
      }
      // --- Ajouter logique autorisation si nécessaire ---
    } catch (authError) {
      logger.error(
        { err: authError, orderId },
        `Error checking order existence/auth for SSE stream.`
      )
      return response.internalServerError({ message: 'Erreur vérification commande.' })
    }
    // ----------------------------------------------

    // --- Configurer Headers SSE ---
    response.response.setHeader('Content-Type', 'text/event-stream')
    response.response.setHeader('Cache-Control', 'no-cache')
    // Keep-Alive est généralement géré par le serveur web (Nginx, etc.) mais on le laisse pour clarté
    response.response.setHeader('Connection', 'keep-alive')
    // Désactiver le buffering Nginx si utilisé comme proxy inverse (important pour SSE !)
    // response.response.setHeader('X-Accel-Buffering', 'no');
    response.response.flushHeaders()
    // -----------------------------

    /** --- Helper pour envoyer un événement SSE ---
     * Gère la conversion JSON et l'écriture formatée.
     */
    const sendEvent = (eventName: string, data: any) => {
      if (response.response.writableEnded) return // Ne pas écrire si la connexion est fermée
      try {
        const jsonData = JSON.stringify(data)
        response.response.write(`event: ${eventName}\n`)
        response.response.write(`data: ${jsonData}\n\n`)
      } catch (e) {
        logger.error(
          { err: e, data },
          `SSE: Failed to stringify data for event ${eventName} [ConnId: ${connectionId}]`
        )
      }
    }

    /** --- Gestion Timeout d'Inactivité ---
     * Réinitialise le timer à chaque activité (ping envoyé ou événement réel)
     */
    const resetInactivityTimeout = () => {
      if (connectionTimeouts.has(connectionId)) {
        clearTimeout(connectionTimeouts.get(connectionId)!)
      }
      const timer = setTimeout(() => {
        logger.warn(
          `SSE: Inactivity timeout for order ${orderId} [ConnId: ${connectionId}]. Closing connection.`)

        // Pas besoin de se désabonner ici, le 'close' event s'en charge
        response.response.end() // Ferme la connexion côté serveur
        connectionTimeouts.delete(connectionId) // Nettoie la map
        if (connectionPings.has(connectionId)) {
          clearInterval(connectionPings.get(connectionId)!) // Arrête le ping aussi
          connectionPings.delete(connectionId)
        }
      }, SSE_INACTIVITY_TIMEOUT_MS)
      connectionTimeouts.set(connectionId, timer)
    }

    /** --- Ping Keep-Alive ---
     * Envoie un commentaire vide pour maintenir la connexion ouverte
     * et réinitialise le timeout d'inactivité.
     */

    const startPing = () => {
      const pingInterval = setInterval(() => {
        if (response.response.writableEnded) {
          // Si fermé entretemps
          clearInterval(pingInterval)
          connectionPings.delete(connectionId)
          return
        }
        response.response.write(': ping\n\n') // Envoie un commentaire SSE standard
        resetInactivityTimeout() // L'envoi du ping compte comme une activité
      }, SSE_PING_INTERVAL_MS)
      connectionPings.set(connectionId, pingInterval)
    }
    // -----------------------------------

    // Envoyer ACK et état initial
    sendEvent('connection_ack', {
      orderId,
      connectionId,
      message: 'Connecté au suivi en temps réel.',
    })
    resetInactivityTimeout() // Reset timer après ACK

    // --- Envoyer l'État Initial (Optimisé et avec Retry simple) ---
    let initialRetryCount = 0
    const sendInitialState = async () => {
      try {
        logger.debug(
          `SSE: Sending initial state for order ${orderId} [ConnId: ${connectionId}] (Attempt ${initialRetryCount + 1})`
        )
        // Requête optimisée : Sélectionne que les champs nécessaires
        const orderInitial = await Order.query()
          .where('id', orderId)
          // Sélection précise des champs pour les relations
          .preload('status_logs', (q) =>
            q.select(['status', 'changed_at']).orderBy('changed_at', 'desc').limit(1)
          )
          .preload('driver', (q) => q.select(['id', 'current_location'])) // Seulement localisation
          .first()

        if (orderInitial) {
          const lastLogInitial = orderInitial.status_logs[0]
          const initialStatus = lastLogInitial?.status ?? OrderStatus.PENDING
          const initialLocation = orderInitial.driver?.current_location
          const initialState = {
            orderId: orderId,
            status: initialStatus,
            lastStatusTimestamp: lastLogInitial?.changed_at?.toISO() ?? null,
            driverLocation: initialLocation
              ? {
                  longitude: initialLocation.coordinates[0],
                  latitude: initialLocation.coordinates[1],
                }
              : null,
            // TODO: Inclure l'ETA initial si pertinent et disponible
            estimatedDelivery: orderInitial.delivery_date_estimation?.toISO(),
          }
          sendEvent('initial_state', initialState)
          resetInactivityTimeout() // Succès, reset timer
        } else {
          // Ne devrait pas arriver si la vérif initiale passe, mais sécurité
          logger.error(`SSE: Order ${orderId} disappeared when fetching initial state?`)
          // Que faire? Fermer la connexion?
          response.response.end()
        }
      } catch (initStateError) {
        logger.error(
          { err: initStateError, orderId },
          `Error sending initial SSE state (Attempt ${initialRetryCount + 1})`
        )
        initialRetryCount++
        if (initialRetryCount < 3) {
          // Retry 2 fois (total 3 tentatives)
          logger.info(`Retrying initial state for ${orderId} in 5 seconds...`)
          setTimeout(sendInitialState, 5000) // Réessaie après 5s
        } else {
          logger.error(
            `SSE: Max retries reached for initial state of order ${orderId}. Closing connection.`
          )
          sendEvent('error', { message: "Impossible de récupérer l'état initial." })
          response.response.end() // Ferme si impossible d'envoyer état initial après retries
        }
      }
    }
    await sendInitialState() // Appelle la fonction pour la première tentative
    // -----------------------------------------------------------

    // --- Définition des Listeners Emitter ---
    const onStatusUpdate = (payload: OrderStatusUpdatePayload) => {
      if (payload.order_id === orderId) {
        logger.debug(
          `SSE: Pushing status update for ${orderId}: ${payload.new_status} [ConnId: ${connectionId}]`
        )
        sendEvent('status_update', payload)
        resetInactivityTimeout() // L'envoi d'un événement compte comme activité
      }
    }
    const onLocationUpdate = (payload: DriverLocationUpdatePayload) => {
      if (payload.order_id === orderId) {
        // Ne pas logger toutes les locations si trop fréquent ? Configurable ?
        logger.trace(`SSE: Pushing location update for ${orderId} [ConnId: ${connectionId}]`)
        sendEvent('location_update', payload)
        resetInactivityTimeout() // L'envoi d'un événement compte comme activité
      }
    }
    // --------------------------------------

    // --- Abonnement & Ping ---
    emitter.on('order:status_updated', onStatusUpdate)
    emitter.on('order:driver_location_updated', onLocationUpdate)
    logger.info(`SSE listeners attached for order ${orderId} [ConnId: ${connectionId}]`)
    startPing() // Démarre l'envoi régulier de pings keep-alive
    // -------------------------

    // --- Gérer la Déconnexion Explicite du Company ---
    request.request.on('close', () => {
      logger.info(`SSE connection closed BY CLIENT for order ${orderId} [ConnId: ${connectionId}]`)
      // Arrêter les timers
      if (connectionTimeouts.has(connectionId)) {
        clearTimeout(connectionTimeouts.get(connectionId)!)
        connectionTimeouts.delete(connectionId)
      }
      if (connectionPings.has(connectionId)) {
        clearInterval(connectionPings.get(connectionId)!)
        connectionPings.delete(connectionId)
      }
      // Se désabonner proprement des événements Emitter
      emitter.off('order:status_updated', onStatusUpdate)
      emitter.off('order:driver_location_updated', onLocationUpdate)
      // response.end() est implicite quand 'close' est émis par Node.js Http Request
    })
  }
} // Fin du Contrôleur
