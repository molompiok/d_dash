import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import DriversStatus from '#models/drivers_status'
import { DriverStatus } from '#models/drivers_status' // Enum
import Driver from '#models/driver'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import { cuid } from '@adonisjs/core/helpers'
import vine from '@vinejs/vine'
import Order, { OrderStatus } from '#models/order'
import emitter from '@adonisjs/core/services/emitter'
import geo_helper from '#services/geo_helper'
const trackableStatuses: OrderStatus[] = [
  OrderStatus.ACCEPTED,
  OrderStatus.AT_PICKUP,
  OrderStatus.EN_ROUTE_TO_DELIVERY,
  OrderStatus.AT_DELIVERY_LOCATION,
]
// Durée maximale (en secondes) pour qu'une localisation soit considérée "récente" et utilisée
// Peut être mise dans config/env
const MAX_LOCATION_AGE_SECONDS = 300
export const updateDriverStatusValidator = vine.compile(
  vine.object({
    // Le livreur ne peut choisir que parmi ces trois statuts manuellement
    status: vine.enum([DriverStatus.ACTIVE, DriverStatus.ON_BREAK, DriverStatus.INACTIVE]),
    // Optionnel : L'app pourrait envoyer des métadonnées (ex: raison de la pause)
    metadata: vine.object({ reason: vine.string().optional() }).optional(),
  })
)

export const updateDriverLocationValidator = vine.compile(
  vine.object({
    // Valide que la latitude et la longitude sont des nombres
    latitude: vine.number().min(-90).max(90),
    longitude: vine.number().min(-180).max(180),
    // Optionnel: Précision, vitesse, timestamp du GPS côté client
    // accuracy: vine.number().min(0).optional(),
    // speed: vine.number().min(0).optional(),
    // timestamp_ms: vine.number().optional()
  })
)

@inject()
export default class DriverStatusController {
  /**
   * [DRIVER] Met à jour SON statut opérationnel (ACTIVE, ON_BREAK, INACTIVE).
   * Enregistre l'historique dans DriversStatus.
   * PATCH /driver/status
   */
  async update_status({ auth, request, response }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate() // Authentifié et est DRIVER (via ACL)
    const userId = user.id
    logger.info(`Mise à jour du statut du driver ${userId}`)
    let payload
    try {
      payload = await request.validateUsing(updateDriverStatusValidator)
    } catch (validationError) {
      logger.warn({ err: validationError }, `Invalid status action for driver ${userId}.`)
      return response.badRequest({
        message: 'Action de statut invalide.',
        errors: validationError.messages,
      })
    }
    const newStatus = payload.status
    try {
      // 1. Trouver le Driver (on pourrait vouloir vérifier certaines conditions)
      //    Exemple : Impossible de passer INACTIVE si en mission (in_work) ?
      //    Pour cela, il faudrait regarder le dernier DriversStatus *AVANT* la mise à jour.
      const driver = await Driver.findBy('user_id', userId)
      logger.info(`Driver trouvé pour user ${JSON.stringify(driver)} lors de update_status`)
      if (!driver) {
        // Ne devrait pas arriver si l'utilisateur existe et a le rôle driver
        logger.error(`Driver non trouvé pour user ${userId} lors de update_status`)
        return response.notFound({ message: 'Profil Livreur non trouvé.' })
      }
      const driverId = driver.id

      // **Vérification Optionnelle mais Recommandée:**
      // Empêcher le passage manuel à INACTIVE ou ON_BREAK s'il est EN MISSION
      const lastStatusRecord = await DriversStatus.query()
        .where('driver_id', driverId)
        .orderBy('changed_at', 'desc')
        .first()

      if (
        lastStatusRecord?.status === DriverStatus.IN_WORK &&
        (newStatus === DriverStatus.INACTIVE || newStatus === DriverStatus.ON_BREAK)
      ) {
        logger.warn(
          `Driver ${driverId} a tenté de passer ${newStatus} alors qu'il est ${lastStatusRecord.status}`
        )
        return response.badRequest({
          message: 'Impossible de changer de statut pendant une mission en cours.',
        })
      }
      // On pourrait aussi vérifier le nombre de missions en cours (assignments_in_progress_count) sur le dernier statut.

      // 2. Créer l'enregistrement d'historique du statut
      // On ne met PAS à jour un champ "status" sur le modèle Driver,
      // car le statut est dérivé du dernier enregistrement dans DriversStatus.
      const newStatusRecord = await DriversStatus.create({
        id: cuid(),
        driver_id: driverId,
        status: newStatus,
        changed_at: DateTime.now(), // Timestamp du changement
        assignments_in_progress_count: lastStatusRecord?.assignments_in_progress_count ?? 0, // Garde le compteur actuel ou 0
        metadata: payload.metadata || undefined, // Stocker les métadonnées si fournies
      })

      logger.info(`Statut du Driver ${driverId} mis à jour vers ${newStatus}`)

      // 3. Réponse
      // Renvoie le nouvel enregistrement de statut ou juste un message de succès
      return response.ok({
        message: `Statut mis à jour avec succès à "${newStatus}".`,
        ...newStatusRecord.serialize(), // Renvoie le nouvel état enregistré
      })
    } catch (error) {
      logger.error({ err: error }, 'Erreur mise à jour statut driver')
      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({ message: 'Statut invalide fourni.', errors: error.messages })
      }
      // Gérer cas de l'erreur lancée par notre vérification manuelle
      if (error.status === 400 && error.message.includes('mission en cours')) {
        return response.badRequest({ message: error.message })
      }
      return response.internalServerError({ message: 'Erreur lors de la mise à jour du statut.' })
    }
  }

  /**
   * [DRIVER] Met à jour SA position géographique actuelle.
   * Stocké dans la colonne `current_location` (PostGIS) du modèle `Driver`.
   * POST /driver/location
   */
  async update_location({ auth, request, response }: HttpContext) {
    // 1. Authentification rapide (via middleware normalement) et récupération ID
    // Pas de .check() bloquant ici, le middleware le fait avant.
    const user = await auth.authenticate() // Utilise '!' car auth middleware garantit user si route protégée
    if (!user) {
      logger.error('Utilisateur non authentifié')
      return response.unauthorized({ message: 'Utilisateur non authentifié.' })
    }
    const driver = await Driver.findBy('user_id', user.id)
    if (!driver) {
      logger.error('Aucun livreur trouvé pour l\'utilisateur', { userId: user.id })
      return response.notFound({ message: 'Aucun livreur trouvé.' })
    }
    const driverId = driver.id

    // 2. Validation Rapide du Payload
    let payload
    try {
      payload = await request.validateUsing(updateDriverLocationValidator)
    } catch (validationError) {
      // Réponse immédiate si invalide, peu coûteux
      return response.badRequest({ errors: validationError.messages })
    }

    // Préparation des données de localisation pour la mise à jour
    const locationData = {
      type: 'Point' as const,
      coordinates: [payload.longitude, payload.latitude],
    }

    // 3. Mise à jour de la localisation du Driver (opération rapide attendue)
    try {
      const affectedRows = await Driver.query().where('id', driverId).update({
        current_location: locationData, // Utilise les données formatées
      })

      if (affectedRows.length === 0) {
        logger.error(`Driver not found (id: ${driverId}) during location update.`)
        // Le driver n'existe pas, 404 silencieux ou erreur selon la logique
        return response.notFound() // 404 si on considère ça comme une ressource non trouvée
      }
      // logger.trace(`Location updated DB for Driver ${driverId}`); // Logger seulement en mode TRACE si besoin
    } catch (dbError) {
      logger.error({ err: dbError, driverId }, 'Failed DB update for driver location.')
      return response.internalServerError({ message: 'Erreur serveur sauvegarde localisation.' })
    }

    // 4. --- Émission ASYNCHRONE de l'événement si nécessaire ---
    //    On vérifie le statut du driver APRES la sauvegarde pour découpler
    await this.emitLocationUpdateIfInWork(driverId, payload.latitude, payload.longitude) // Appel non bloquant (async mais on n'attend pas)

    // 5. Réponse rapide au Driver (204 No Content)
    // La réponse est envoyée AVANT que la vérification de statut et l'émission d'événement aient lieu.
    return response.noContent()
  }

  private async emitLocationUpdateIfInWork(driverId: string, latitude: number, longitude: number) {
    try {
      // Récupère le dernier statut connu le plus efficacement possible
      const lastStatusRecord = await DriversStatus.query()
        .select('status') // Sélectionne que le statut
        .where('driver_id', driverId)
        .orderBy('changed_at', 'desc')
        .first()

      if (lastStatusRecord?.status === DriverStatus.IN_WORK) {
        // Trouver les commandes pertinentes de ce driver (requête optimisée)
        const activeOrders = await Order.query()
          .select('id', 'client_id') // Sélectionne juste ce dont on a besoin
          .where('driver_id', driverId)
          // jointure pour vérifier le dernier statut Order directement en BDD
          .whereHas('status_logs', (logQuery) => {
            logQuery
              .whereIn('status', trackableStatuses)
              .orderBy('changed_at', 'desc')
              .limit(1)
              // S'assurer que le dernier statut est bien dans la liste
              .whereIn('status', trackableStatuses) // Double check ou structure join plus complexe
          })
          .preload('client', (c) => c.select('user_id')) // Besoin user_id du client

        if (activeOrders.length > 0) {
          logger.trace(
            `Driver ${driverId} is IN_WORK on ${activeOrders.length} trackable order(s). Emitting location...`
          )
          for (const order of activeOrders) {
            const travelTime = await geo_helper.calculateTravelTime(
              [latitude, longitude],
              order.delivery_address.coordinates.coordinates
            )
            if (order.client?.user_id) {
              emitter.emit('order:driver_location_updated', {
                orderId: order.id,
                clientId: order.client_id,
                driverId: driverId,
                location: { latitude, longitude },
                timestamp: DateTime.now().toISO(),
                // TODO: Calculer ETA ici si possible et l'inclure
                etaSeconds: travelTime?.durationSeconds ?? null,
              })
            }
          }
        }
      }
    } catch (error) {
      logger.error({ err: error, driverId }, 'Error in background task emitLocationUpdateIfInWork')
      // Erreur lors de la vérification de statut ou recherche de commandes,
      // l'émission de localisation n'a pas lieu pour cette mise à jour. Non critique pour l'API.
    }
  }

  /**
   * [DRIVER] Récupère SON DERNIER statut enregistré.
   * Utile pour l'app driver pour connaître son état actuel.
   * GET /driver/status
   */
  async get_current_status({ auth, response }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate() // Utilise '!' car auth middleware garantit user si route protégée
    if (!user) {
      logger.error('Utilisateur non authentifié')
      return response.unauthorized({ message: 'Utilisateur non authentifié.' })
    }
    const driver = await Driver.findBy('user_id', user.id)
    if (!driver) {
      logger.error('Aucun livreur trouvé pour l\'utilisateur', { userId: user.id })
      return response.notFound({ message: 'Aucun livreur trouvé.' })
    }
    const driverId = driver.id

    try {
      const lastStatusRecord = await DriversStatus.query()
        .where('driver_id', driverId)
        .orderBy('changed_at', 'desc')
        .first() // Récupère le plus récent

      if (!lastStatusRecord) {
        // Cas où le driver n'a encore jamais défini de statut (ex: juste après inscription)
        // On peut retourner un statut 'INACTIVE' par défaut ou 404.
        return response.ok({
          message: 'Aucun statut précédent trouvé, considéré comme Inactif.',
          current_status: {
            // Retourne un objet formaté comme DriversStatus mais avec statut par défaut
            driver_id: driverId,
            status: DriverStatus.INACTIVE,
            changed_at: DateTime.now(), // Ou null ?
            assignments_in_progress_count: 0,
            metadata: null,
          },
        })
        // OU: return response.notFound({ message: 'Aucun statut trouvé pour ce livreur.' });
      }

      return response.ok({
        message: 'Statut actuel récupéré.',
        current_status: lastStatusRecord.serialize(), // Renvoie le dernier enregistrement
      })
    } catch (error) {
      logger.error({ err: error, driverId: user.id }, 'Erreur récupération statut driver')
      return response.internalServerError({ message: 'Erreur lors de la récupération du statut.' })
    }
  }
} // Fin du contrôleur
