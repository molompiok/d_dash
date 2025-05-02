/* eslint-disable @typescript-eslint/naming-convention */
import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import db from '@adonisjs/lucid/services/db'
import Order from '#models/order'
import Address from '#models/address'
import Package from '#models/package'
import Driver from '#models/driver'
import { VehicleStatus } from '#models/driver_vehicle'
import DriversStatus, { DriverStatus } from '#models/drivers_status'
import {
  OrderStatus,
  CancellationReasonCode,
  FailureReasonCode,
  OrderPriority,
} from '#models/order' // Enums Order
import { PackageMentionWarning } from '#models/package' // Enum Package

import logger from '@adonisjs/core/services/logger'
import { cuid } from '@adonisjs/core/helpers'
import { DateTime } from 'luxon'

// --- Import des Helpers/Wrappers (chemins à adapter) ---
import GeoHelper from '#services/geo_helper' // Fonctions geocodeAddress, calculateRouteDetails
import PricingHelper, { SimplePackageInfo } from '#services/pricing_helper' // Fonction calculateFees
import RedisHelper from '#services/redis_helper' // Fonction publishMissionOffer
// --- Fin Imports Helpers ---

// --- Import des Validateurs ---
import vine from '@vinejs/vine'
import OrderStatusLog from '#models/order_status_log'
import env from '#start/env'
import Client from '#models/client'
import redis_helper from '#services/redis_helper'
// --- Fin Imports Validateurs ---

const cancelOrderValidator = vine.compile(
  vine.object({
    reason_code: vine.enum(CancellationReasonCode), // Raison de l'annulation
    metadata: vine
      .object({
        reason: vine.string(),
        delivery_type: vine.string().optional(),
        details: vine.string().optional(),
      })
      .nullable(),
  })
)

const assignDriverValidator = vine.compile(
  vine.object({
    driver_id: vine.string(), // L'ID du driver à assigner
  })
)

const listOrdersQueryValidator = vine.compile(
  vine.object({
    status: vine.enum(OrderStatus).optional(),
    client_id: vine.string().optional(),
    driver_id: vine.string().optional(),
    date_from: vine
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    date_to: vine
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    page: vine.number().min(1).optional(),
    perPage: vine.number().min(1).max(100).optional(),
  })
)

const packageDimensionsValidator = vine.object({
  weight_g: vine.number().positive(),
  depth_cm: vine.number().positive().optional(),
  width_cm: vine.number().positive().optional(),
  height_cm: vine.number().positive().optional(),
})

export const createOrderValidator = vine.compile(
  vine.object({
    // Adresses en texte simple (la validation de la *validité* de l'adresse est déléguée au géocodage)
    pickup_address_text: vine.string().trim().minLength(3),
    delivery_address_text: vine.string().trim().minLength(3),

    // Détails des colis
    packages: vine
      .array(
        vine.object({
          name: vine.string().trim().minLength(3), // Nom/Description courte
          description: vine.string().trim().optional().optional(),
          dimensions: packageDimensionsValidator,
          mention_warning: vine.enum(PackageMentionWarning).optional(), // Enum pour fragile, froid, etc.
          quantity: vine.number().min(1),
          //   image_urls: vine.array(vine.string().url()), // Si on permet au client de joindre des images
        })
      )
      .minLength(1),

    // Autres infos
    note_order: vine.string().minLength(5).trim().optional().nullable(), // Instructions spéciales
    // delivery_date_request: vine.string().regex(...).optional() // Si on permet de demander une date/heure
  })
)

@inject()
export default class OrderController {
  // Injection possible des helpers si ce sont des classes/services enregistrés
  // constructor(
  //    private geoHelper: GeoHelper,
  //    private pricingHelper: PricingHelper,
  //    private redisHelper: RedisHelper,
  //    private notificationHelper: NotificationHelper
  // ) {}

  // ===============================================
  // Méthodes pour les Clients / API Entreprise
  // ===============================================

  /**
   * [CLIENT/API] Crée une nouvelle commande de livraison.
   * POST /orders
   */
  async create_order({ request, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('client')
    if (!user.client) {
      return response.forbidden({ message: 'Utilisateur non associé à un compte client.' })
    }
    const clientId = user.client.id

    // TODO: Vérifier la limite d'abonnement du client si implémenté.

    // --- Configuration Globale (depuis env ou config) ---
    const OFFER_DURATION_SECONDS = Number.parseInt(
      env.get('DRIVER_OFFER_DURATION_SECONDS', '20'),
      10
    )
    const ETA_BUFFER_MINUTES = Number.parseInt(env.get('DELIVERY_ETA_BUFFER_MINUTES', '15'), 10)
    const DRIVER_SEARCH_RADIUS_KM = Number.parseInt(env.get('DRIVER_SEARCH_RADIUS_KM', '10'), 10)
    const ASSIGNMENT_MAX_CANDIDATES = 5 // Nb max de drivers récupérés par la requête initiale
    // ------------------------------------------------------

    // 1. Valider le payload
    let payload
    try {
      payload = await request.validateUsing(createOrderValidator)
    } catch (validationError) {
      logger.warn(
        { err: validationError },
        `Validation failed for order creation by client ${clientId}`
      )
      return response.badRequest({
        message: 'Données invalides.',
        errors: validationError.messages,
      })
    }

    let pickupAddress: Address | null = null
    let deliveryAddress: Address | null = null
    let newOrder: Order | null = null
    const trx = await db.transaction()

    try {
      // 2. Géocodage (Gestion Erreur spécifique)
      let pickupCoords
      let deliveryCoords
      try {
        pickupCoords = await GeoHelper.geocodeAddress(payload.pickup_address_text)
        logger.info(`Adresse de départ géocodée: ${JSON.stringify(pickupCoords)}`)
        if (!pickupCoords) throw new Error(`Adresse de départ introuvable: ${payload.pickup_address_text}`)
        deliveryCoords = await GeoHelper.geocodeAddress(payload.delivery_address_text)
        logger.info(`Adresse de livraison géocodée: ${JSON.stringify(deliveryCoords)}`)
        if (!deliveryCoords) throw new Error(`Adresse de livraison introuvable: ${payload.delivery_address_text}`)
      } catch (geoError) {
        await trx.rollback() // Important d'annuler même si l'erreur est avant les écritures DB
        logger.warn(
          { err: geoError },
          `Geocoding failed during order creation for client ${clientId}`
        )
        // Message plus générique pour ne pas exposer les détails de l'adresse si l'erreur vient de là
        return response.badRequest({
          message: `Erreur lors de la validation de l'adresse: ${geoError.message}`,
        })
      }

      // 3. Création Addresses
      pickupAddress = await Address.create(
        {
          id: cuid(),
          street_address: payload.pickup_address_text,
          city: pickupCoords.city || 'N/A',
          postal_code: pickupCoords.postcode || 'N/A',
          country: pickupCoords.country_code?.toUpperCase() || 'N/A',
          coordinates: { type: 'Point', coordinates: pickupCoords.coordinates },
          address_details: JSON.stringify(pickupCoords), // Stocke les détails bruts pour ref
        },
        { client: trx }
      )
      deliveryAddress = await Address.create(
        {
          id: cuid(),
          street_address: payload.delivery_address_text,
          city: deliveryCoords.city || 'N/A',
          postal_code: deliveryCoords.postcode || 'N/A',
          country: deliveryCoords.country_code?.toUpperCase() || 'N/A',
          coordinates: { type: 'Point', coordinates: deliveryCoords.coordinates },
        },
        { client: trx }
      )

      // 4. Calcul Itinéraire & Prix (Gestion Erreur spécifique)
      let routeDetails
      let clientFee: number
      let driverRemuneration: number
      try {
        routeDetails = await GeoHelper.calculateRouteDetails(
          pickupAddress.coordinates.coordinates,
          deliveryAddress.coordinates.coordinates
        )
        if (!routeDetails) throw new Error("Impossible de calculer l'itinéraire.")

        const packageInfoForPricing: SimplePackageInfo[] = payload.packages.map((pkg) => ({
          name: pkg.name,
          dimensions: pkg.dimensions,
          quantity: pkg.quantity,
        }))
        const fees = await PricingHelper.calculateFees(
          routeDetails.distanceMeters,
          routeDetails.durationSeconds,
          packageInfoForPricing
        )
        clientFee = fees.clientFee
        driverRemuneration = fees.driverRemuneration
      } catch (routePriceError) {
        await trx.rollback()
        logger.warn(
          { err: routePriceError },
          `Routing/Pricing failed for order creation for client ${clientId}`
        )
        return response.badRequest({
          message: `Erreur de calcul de l'itinéraire ou du prix: ${routePriceError.message}`,
        })
      }
      const estimatedDeliveryTime = DateTime.now()
        .plus({ seconds: routeDetails.durationSeconds })
        .plus({ minutes: ETA_BUFFER_MINUTES }) // Buffer configurable

      // 5. Créer l'objet Order (avec champs offre init à null)
      newOrder = await Order.create(
        {
          id: cuid(),
          client_id: clientId,
          driver_id: null,
          pickup_address_id: pickupAddress.id,
          delivery_address_id: deliveryAddress.id,
          priority: OrderPriority.MEDIUM,
          note_order: payload.note_order,
          //   currency: env.get('APP_CURRENCY', 'EUR'),
          client_fee: Math.round(clientFee), //TODO mettre float dans la DB
          remuneration: Math.round(driverRemuneration), //TODO mettre float dans la DB
          route_distance_meters: routeDetails.distanceMeters,
          route_duration_seconds: routeDetails.durationSeconds,
          route_geometry: routeDetails.geometry,
          calculation_engine: routeDetails.engine,
          delivery_date_estimation: estimatedDeliveryTime,
          delivery_date: DateTime.now().plus({ seconds: routeDetails.durationSeconds + (ETA_BUFFER_MINUTES + 600) * 60 * 60 * 1000 }),
          proof_of_pickup_media: [],
          proof_of_delivery_media: [],
          cancellation_reason_code: null,
          failure_reason_code: null,
          offered_driver_id: null, // --- Ajouté pour Scénario Idéal ---
          offer_expires_at: null, // --- Ajouté pour Scénario Idéal ---
        },
        { client: trx }
      )

      // 6. Créer Packages
      if (!payload.packages || payload.packages.length === 0)
        throw new Error('Liste de colis vide.')
      const packagesData = payload.packages.map((pkgData) => ({
        id: cuid(),
        order_id: newOrder!.id,
        name: pkgData.name,
        description: pkgData.description,
        dimensions: pkgData.dimensions,
        mention_warning: pkgData.mention_warning,
        quantity: pkgData.quantity || 1,
        image_urls: [],
        is_return: false,
      }))
      await Package.createMany(packagesData, { client: trx })

      // 7. Créer Log PENDING initial
      await OrderStatusLog.create(
        {
          id: cuid(),
          order_id: newOrder!.id,
          status: OrderStatus.PENDING,
          changed_at: newOrder!.created_at,
          changed_by_user_id: user.id,
          current_location: pickupAddress.coordinates,
          metadata: null,
          created_at: newOrder!.created_at ?? DateTime.now(),
        },
        { client: trx }
      )

      // 8. --- DÉCLENCHEMENT OFFRE INITIALE (SCÉNARIO IDÉAL) ---
      let offerSent = false // Flag pour savoir si l'offre a bien été notifiée
      try {
        const pickupPoint = pickupAddress.coordinates.coordinates

        // TODO: Calculer poids/volume total ici pour filtre véhicule
        const totalWeightG = payload.packages.reduce(
          (sum, pkg) => sum + pkg.dimensions.weight_g * (pkg.quantity || 1),
          0
        )
        // const totalVolumeM3 = ... calcul similaire ...

        // Requête améliorée avec vérification véhicule basique (poids)
        const availableDrivers = await Driver.query({ client: trx })
          // Jointure pour obtenir le dernier statut
          .joinRaw(
            `
                   INNER JOIN (
                       SELECT driver_id, status, changed_at
                       FROM driver_statuses ds1
                       WHERE changed_at = (SELECT MAX(changed_at) FROM driver_statuses ds2 WHERE ds1.driver_id = ds2.driver_id)
                   ) latest_status ON latest_status.driver_id = drivers.id
               `
          )
          .preload('vehicles', (vQuery) => vQuery.where('status', VehicleStatus.ACTIVE)) // Véhicules actifs seulement
          .where('latest_status.status', DriverStatus.ACTIVE) // Driver prêt
          .whereNotNull('current_location') // Driver a partagé sa position
          // Filtre par distance PostGIS
          .whereRaw(
            'ST_DistanceSphere(current_location::geometry, ST_MakePoint(?, ?)::geometry) <= ?',
            [
              pickupPoint[0], // longitude
              pickupPoint[1], // latitude
              DRIVER_SEARCH_RADIUS_KM * 1000, // distance en mètres
            ]
          )
          // TODO: Filtre par capacité/type de véhicule vs package (plus complexe, nécessite jointure/filtre sur vehicles préchargés)
          .orderByRaw('drivers.average_rating DESC NULLS LAST') // Meilleure note d'abord
          .orderByRaw(
            'ST_DistanceSphere(current_location::geometry, ST_MakePoint(?, ?)::geometry) ASC',
            [pickupPoint[0], pickupPoint[1]]
          ) // Plus proche ensuite
          .limit(ASSIGNMENT_MAX_CANDIDATES) // Limite le nombre de candidats potentiels

        // --- Filtrage Véhicule Post-Requête (Exemple Simplifié) ---
        const suitableDriver = availableDrivers.find(
          (driver) =>
            driver.vehicles.length > 0 && // Au moins un véhicule ACTIF
            driver.vehicles.some((v) => v.max_weight_kg >= totalWeightG) // Au moins un véhicule peut prendre le poids
          // && driver.vehicles.some(v => /* test volume */)
          // && driver.vehicles.some(v => /* test frigo si besoin */)
        )
        // --- Fin Filtrage Véhicule ---

        if (suitableDriver) {
          const selectedDriver = suitableDriver
          const expiresAt = DateTime.now().plus({ seconds: OFFER_DURATION_SECONDS })

          //   a. Mettre à jour l'Order avec l'offre
          newOrder.offered_driver_id = selectedDriver.id
          newOrder.offer_expires_at = expiresAt
          await newOrder.save() // Toujours via trx

          //   b. Notifier le driver (via Push)
          if (selectedDriver.fcm_token) {
            const notifTitle = 'Nouvelle Mission Disponible'
            const notifBody = `Course #${newOrder.id.substring(0, 6)}... Rém: ${newOrder.remuneration} ${newOrder.currency}. Acceptez avant ${expiresAt.toFormat('HH:mm:ss')}`
            const notifData = {
              type: 'NEW_MISSION_OFFER',
              orderId: newOrder.id,
              offerExpiresAt: expiresAt.toISO(),
            }
            const pushSent = await redis_helper.enqueuePushNotification(
              selectedDriver.fcm_token,
              notifTitle,
              notifBody,
              notifData
            )
            if (pushSent) {
              logger.info(
                `Offre initiale Order ${newOrder.id} notifiée Driver ${selectedDriver.id}`
              )
              offerSent = true
            } else {
              logger.warn(
                `Échec envoi push offre Order ${newOrder.id} à Driver ${selectedDriver.id}. Annulation offre.`
              )
              // Annuler l'offre sur l'order si l'envoi échoue
              newOrder.offered_driver_id = null
              newOrder.offer_expires_at = null
              await newOrder.save() // via trx
              // TODO: Que faire ensuite ? Essayer un autre driver? Mettre en attente ? -> Dépend de la logique du Worker/Batch
            }
          } else {
            logger.warn(
              `Driver ${selectedDriver.id} (suitable) n'a pas de FCM Token. Annulation offre.`
            )
            // Annuler l'offre car non notifiable
            newOrder.offered_driver_id = null
            newOrder.offer_expires_at = null
            await newOrder.save() // via trx
            // TODO: Essayer prochain driver?
          }
        } else {
          logger.warn(`Aucun driver approprié (dispo+véhicule) trouvé pour Order ${newOrder.id}.`)
          // L'order reste PENDING sans offre active.
        }
      } catch (assignmentError) {
        // Erreur PENDANT la recherche de driver ou l'envoi de notif, après la création de la commande
        logger.error(
          { err: assignmentError, orderId: newOrder!.id },
          "Erreur pendant la phase d'offre initiale. La commande reste PENDING."
        )
        // Ne pas rollback la transaction ici, car la commande a bien été créée.
        // Le worker/batch devra gérer cette commande.
      }
      // --- Fin Déclenchement Offre ---

      // 9. TODO: MAJ compteur client

      // 10. Commit la transaction (Création Order/Addr/Pack/Log ET potentiel état d'offre)
      await trx.commit()

      // 11. Réponse au client
      const message = offerSent
        ? 'Commande créée. Une offre a été envoyée à un livreur.'
        : "Commande créée. Recherche d'un livreur en cours..."
      // Charge les relations nécessaires pour la réponse
      await newOrder.load('pickup_address')
      await newOrder.load('delivery_address')
      await newOrder.load('packages') // Charge tous les packages créés

      return response.created({
        message: message,
        order: newOrder.serialize({ fields: { omit: ['confirmation_code'] } }),
      })
    } catch (error) {
      // Gérer ici les erreurs survenues AVANT ou PENDANT la transaction, MAIS PAS après le commit
      if (!trx.isCompleted) {
        // S'assure que le rollback n'est pas déjà fait
        await trx.rollback()
      }
      logger.error(
        { err: error, clientId: clientId, payload: payload },
        'Erreur globale création commande store'
      )
      if (error.code === 'E_VALIDATION_ERROR') {
        // Devrait être attrapé avant
        return response.badRequest({ message: 'Données invalides.', errors: error.messages })
      }
      // Retourner des erreurs plus spécifiques attrapées plus tôt si possible
      if (error.status) return response.status(error.status).send({ message: error.message })

      return response.internalServerError({
        message: 'Erreur serveur lors de la création de la commande.',
      })
    }
  }

  /**
   * [CLIENT/API] Récupère les détails d'une commande spécifique du client connecté.
   * GET /orders/:id
   */
  async show({ params, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('client')
    if (!user.client) return response.forbidden({ message: 'Client non trouvé.' })

    const orderId = params.id

    try {
      const order = await Order.query()
        .where('id', orderId)
        .andWhere('client_id', user.client.id) // Le client ne voit que SES commandes
        .preload('pickup_address')
        .preload('delivery_address')
        .preload('packages')
        .preload('driver', (driverQuery) =>
          //@ts-ignore
          driverQuery.preload('user', (userQuery) => userQuery.select(['id', 'full_name', 'photo']))
        ) // Charger le driver et user associé (sélection de champs)
        .preload('status_logs', (logQuery) => logQuery.orderBy('changed_at', 'desc')) // Historique des statuts
        .first()

      if (!order) {
        return response.notFound({ message: 'Commande non trouvée.' })
      }

      return response.ok(order.serialize({ fields: { omit: ['confirmation_code'] } })) // Omet le code ici aussi
    } catch (error) {
      logger.error(
        { err: error, orderId, clientId: user.client.id },
        'Erreur récupération commande client'
      )
      return response.internalServerError({
        message: 'Erreur serveur lors de la récupération de la commande.',
      })
    }
  }

  /**
   * [CLIENT/API] Liste les commandes du client connecté.
   * GET /orders
   */
  async index({ request, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('client')
    if (!user.client) return response.forbidden({ message: 'Client non trouvé.' })

    // Pagination simple pour la liste client
    const page = request.input('page', 1)
    const perPage = request.input('perPage', 15)

    try {
      const ordersPaginated = await Order.query()
        .where('client_id', user.client.id)
        .preload('pickup_address', (q) => q.select(['city', 'street_address'])) // Charger juste quelques infos
        .preload('delivery_address', (q) => q.select(['city', 'street_address']))
        .preload('packages', (q) => q.select(['name', 'dimensions']))
        .orderBy('created_at', 'desc') // Les plus récentes d'abord
        .paginate(page, perPage)

      return response.ok(ordersPaginated.toJSON())
    } catch (error) {
      logger.error({ err: error, clientId: user.client.id }, 'Erreur listage commandes client')
      return response.internalServerError({
        message: 'Erreur serveur lors du listage des commandes.',
      })
    }
  }

  /**
   * [CLIENT/API] Annule une commande (si possible).
   * POST /orders/:id/cancel
   */
  async cancel({ params, request, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('client')
    if (!user.client) return response.forbidden({ message: 'Client non trouvé.' })

    const orderId = params.id

    // Valider la raison de l'annulation
    const { metadata } = await request.validateUsing(cancelOrderValidator)

    const trx = await db.transaction()
    try {
      // Trouver la commande DU client DANS la transaction
      const order = await Order.query({ client: trx })
        .where('id', orderId)
        .andWhere('client_id', user.client.id)
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1)) // Charger le dernier statut
        .first()

      if (!order) {
        await trx.rollback()
        return response.notFound({ message: 'Commande non trouvée.' })
      }

      // Logique de permission d'annulation
      const currentStatus =
        order.status_logs.length > 0 ? order.status_logs[0].status : OrderStatus.PENDING
      const isCancellable = [
        OrderStatus.PENDING,
        OrderStatus.AT_PICKUP,
        OrderStatus.ACCEPTED,
      ].includes(currentStatus) // Peut-on annuler après ACCEPTED? A définir.

      if (!isCancellable) {
        await trx.rollback()
        return response.badRequest({
          message: `Impossible d'annuler une commande avec le statut actuel (${currentStatus}).`,
        })
      }

      // Mettre à jour la commande
      //   order.status = OrderStatus.CANCELLED
      OrderStatusLog.create(
        {
          id: cuid(),
          order_id: orderId,
          status: OrderStatus.CANCELLED,
          changed_at: DateTime.now(),
          changed_by_user_id: user.id,
          metadata,
          current_location: order.pickup_address.coordinates,
        },
        { client: trx }
      )
      await order.save() // Toujours utiliser la transaction (via find)

      // --- SI UN DRIVER ÉTAIT ASSIGNÉ ---
      if (order.driver_id && currentStatus === OrderStatus.ACCEPTED) {
        logger.info(
          `Commande ${orderId} annulée alors qu'elle était acceptée par driver ${order.driver_id}`
        )

        // Mettre à jour le statut du driver (via nouvel enregistrement DriversStatus)
        // Doit repasser ACTIVE s'il n'a plus d'autres missions
        const lastDriverStatus = await DriversStatus.query({ client: trx })
          .where('driver_id', order.driver_id)
          .orderBy('changed_at', 'desc')
          .first()

        if (lastDriverStatus && lastDriverStatus.status === DriverStatus.IN_WORK) {
          // On décrémente le compteur de missions
          const newAssignmentCount = Math.max(
            0,
            (lastDriverStatus.assignments_in_progress_count || 1) - 1
          )

          // Si le compteur tombe à 0, on le remet 'ACTIVE'
          if (newAssignmentCount === 0) {
            await DriversStatus.create(
              {
                id: cuid(),
                driver_id: order.driver_id,
                status: DriverStatus.ACTIVE,
                changed_at: DateTime.now(),
                assignments_in_progress_count: 0,
              },
              { client: trx }
            )
            logger.info(`Driver ${order.driver_id} remis à ACTIVE après annulation commande.`)
          } else {
            // Il a encore d'autres missions, on met juste à jour son compteur sur un nouvel event ? Non, plutôt sur le prochain changement.
            // Pour simplifier ici, on assume que le compteur est implicitement géré ailleurs.
            // OU on pourrait créer un statut custom "assignment_cancelled" ou ne rien faire ?
            // -> Solution la plus simple: ne rien faire ici, le compteur sera correct la prochaine fois qu'il change de statut (ex: fin d'une autre mission).
            logger.info(
              `Driver ${order.driver_id} a encore ${newAssignmentCount} mission(s) après annulation.`
            )
            // ON MET QUAND MÊME A JOUR LE COMPTEUR sur un nouvel event status in_work
            await DriversStatus.create(
              {
                id: cuid(),
                driver_id: order.driver_id,
                status: DriverStatus.IN_WORK,
                changed_at: DateTime.now(),
                assignments_in_progress_count: newAssignmentCount,
              },
              { client: trx }
            )
          }
        }

        // TODO: Notifier le Driver de l'annulation
        // const driver = await Driver.find(order.driver_id, { client: trx });
        const driver = await Driver.query({ client: trx })
          .where('id', order.driver_id)
          //@ts-ignore
          .preload('user', (q) => q.select(['id', 'fcm_token']))
          .first()

        //Envoyer au client
        const client = await Client.query({ client: trx })
          .where('id', order.client_id)
          //@ts-ignore
          .preload('user', (q) => q.select(['id', 'fcm_token']))
          .first()

        if (client?.fcm_token)
          await redis_helper.enqueuePushNotification(
            client.fcm_token,
            'Commande annulée',
            'La commande a été annulée.'
          )

        if (driver?.fcm_token)
          await redis_helper.enqueuePushNotification(
            driver.fcm_token,
            'Commande annulée',
            "La commande a été annulée par l'administrateur."
          )
      }

      await trx.commit() // Valide l'annulation

      return response.ok({ message: 'Commande annulée avec succès.' })
    } catch (error) {
      /* ... gestion erreur cancel et rollback ... */
    }
  }

  // ===============================================
  // Méthodes pour les Admins
  // ===============================================

  /**
   * [ADMIN] Liste TOUTES les commandes avec filtres.
   * GET /admin/orders
   */
  async admin_index({ request, response, auth }: HttpContext) {
    // Vérification admin via ACL
    await auth.check()
    try {
      const queryParams = await request.validateUsing(listOrdersQueryValidator)
      const query = Order.query()
        // @ts-ignore
        .preload('user', (q) => q.select(['id', 'full_name', 'email']))
        // @ts-ignore
        .preload('driver', (q) => q.preload('user', (u) => u.select(['id', 'full_name', 'email'])))
        .preload('pickup_address')
        .preload('delivery_address')
        .preload('packages')

      if (queryParams.status) {
        query.where('status', queryParams.status)
      }
      if (queryParams.client_id) {
        query.where('client_id', queryParams.client_id)
      }
      if (queryParams.driver_id) {
        query.where('driver_id', queryParams.driver_id)
      }
      if (queryParams.date_from) {
        query.where('created_at', '>=', queryParams.date_from + ' 00:00:00')
      }
      if (queryParams.date_to) {
        query.where('created_at', '<=', queryParams.date_to + ' 23:59:59')
      }

      const page = queryParams.page || 1
      const perPage = queryParams.perPage || 20
      const ordersPaginated = await query.orderBy('created_at', 'desc').paginate(page, perPage)
      return response.ok(ordersPaginated.toJSON())
    } catch (error) {
      /* ... gestion erreur admin index ... */
    }
  }
  /**
   * [ADMIN] Récupère les détails d'une commande spécifique par son ID.
   * GET /admin/orders/:id
   */
  async admin_show({ params, response, auth }: HttpContext) {
    await auth.check() // Vérification admin via ACL
    const orderId = params.id

    try {
      const order = await Order.query()
        .where('id', orderId)
        //@ts-ignore
        .preload('user')
        //@ts-ignore
        .preload('driver', (q) => q.preload('user'))
        .preload('pickup_address')
        .preload('delivery_address')
        .preload('packages')
        .preload('status_logs', (q) =>
          q
            .orderBy('changed_at', 'desc')
            //@ts-ignore
            .preload('changed_by_user', (u) => u.select(['id', 'full_name', 'role']))
        ) // Historique complet avec user
        .first()

      if (!order) {
        return response.notFound({ message: 'Commande non trouvée.' })
      }
      return response.ok(order.serialize())
    } catch (error) {
      logger.error({ err: error, orderId }, 'Erreur récupération commande admin')
      return response.internalServerError({
        message: 'Erreur serveur lors de la récupération de la commande.',
      })
    }
  }

  /**
   * [CLIENT/API/PUBLIC?] Récupère les informations de suivi d'une commande.
   * Renvoie le dernier statut connu et la localisation du livreur si en cours.
   * GET /orders/:id/track  (ou /track/:orderId)
   */
  async track({ params, response, auth }: HttpContext) {
    // --- Gestion de l'Authentification/Autorisation ---
    // Doit-on être le client propriétaire pour tracker ? Ou est-ce public ?
    // Option 1: Public (n'importe qui avec l'ID peut suivre) - Pas d'auth ici.
    // Option 2: Client propriétaire seulement - Décommenter les lignes auth ci-dessous.
    // await auth.check();
    // const user = await auth.authenticate();
    // await user.load('client');
    // if (!user.client) return response.forbidden({ message: 'Client non trouvé.' });
    // ----------------------------------------------------

    const orderId = params.id
    logger.debug(`Tracking request for Order ${orderId}`)

    try {
      // 1. Récupérer la commande et son dernier statut logué
      const order = await Order.query()
        .where('id', orderId)
        // Précharge le dernier log de statut (le plus récent)
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1))
        //@ts-ignore
        .preload('driver', (q) => q.preload('user', (u) => u.select(['id', 'full_name', 'photo'])))
        // Précharge le driver SI assigné
        .preload('driver', (q) => q.select(['id', 'current_location'])) // Sélectionne que l'ID et la localisation
        // Optionnel: Précharger l'adresse de livraison pour l'ETA ?
        .preload('delivery_address', (q) => q.select(['coordinates']))
        .first()

      if (!order) {
        return response.notFound({ message: 'Commande non trouvée.' })
      }

      // 2. Extraire les informations pertinentes
      const lastLog = order.status_logs.length > 0 ? order.status_logs[0] : null
      const currentStatus = lastLog?.status ?? OrderStatus.PENDING // Défaut PENDING si pas de log (ne devrait pas arriver)
      const lastStatusTimestamp = lastLog?.changed_at

      // Statuts où la localisation du driver est pertinente
      const trackableStatuses = [
        OrderStatus.ACCEPTED, // Commence à être pertinent ici
        OrderStatus.AT_PICKUP,
        OrderStatus.EN_ROUTE_TO_DELIVERY,
        OrderStatus.AT_DELIVERY_LOCATION,
      ]

      let driverLocation: { latitude: number; longitude: number } | null = null
      let estimatedTimeToArrivalSeconds: number | null = null

      // 3. Récupérer la localisation du driver SI il est assigné ET dans un statut pertinent
      if (order.driver && trackableStatuses.includes(currentStatus)) {
        // Vérifier si la localisation du driver existe et est récente ? (Optionnel)
        if (order.driver.current_location) {
          driverLocation = {
            // L'ordre dans GeoJSON est [longitude, latitude]
            longitude: order.driver.current_location.coordinates[0],
            latitude: order.driver.current_location.coordinates[1],
          }

          // --- BONUS: Calcul ETA vers le prochain point clé ---
          if (order.delivery_address?.coordinates) {
            try {
              // Itinéraire de la position ACTUELLE du driver vers la livraison
              const routeToDelivery = await GeoHelper.calculateRouteDetails(
                order.driver.current_location.coordinates,
                order.delivery_address.coordinates.coordinates
              )
              if (routeToDelivery) {
                estimatedTimeToArrivalSeconds = routeToDelivery.durationSeconds
              }
            } catch (etaError) {
              logger.warn({ err: etaError, orderId }, 'Failed to calculate ETA for tracking')
            }
          }
          // --- Fin Bonus ETA ---
        }
      }

      // 4. Construire la réponse
      const responseData = {
        orderId: order.id,
        currentStatus: currentStatus, // Dernier statut logué
        lastStatusTimestamp: lastStatusTimestamp?.toISO() ?? null, // Timestamp du dernier statut

        // Informations de localisation SI disponibles et pertinentes
        driverLocation: driverLocation, // { latitude, longitude } ou null

        // ETA Simplifié (basé sur l'estimation initiale stockée sur l'order)
        // Si la commande n'est pas encore livrée/échouée/annulée
        estimatedDelivery: ![
          OrderStatus.SUCCESS,
          OrderStatus.FAILED,
          OrderStatus.CANCELLED,
        ].includes(currentStatus)
          ? (order.delivery_date_estimation?.toISO() ?? null)
          : null,

        // ETA Calculé (si implémenté dans le bonus)
        etaSeconds: estimatedTimeToArrivalSeconds,

        // Ajouter d'autres infos utiles ? (Ex: Nom du livreur simplifié ?)
        // driverInfo: order.driver ? { name: order.driver.user?.full_name ?? 'Livreur assigné' } : null // Nécessiterait préchargement user du driver
      }

      return response.ok(responseData)
    } catch (error) {
      logger.error({ err: error, orderId }, 'Erreur lors du tracking de la commande')
      // Gérer le cas où l'ID n'est pas valide si besoin (ex:  invalide)
      if (error.code === 'E_ROW_NOT_FOUND') {
        // Si order non trouvé via query()
        return response.notFound({ message: 'Commande non trouvée.' })
      }
      // Erreur générique
      return response.internalServerError({
        message: 'Erreur serveur lors du suivi de la commande.',
      })
    }
  } // Fin track

  /**
   * [ADMIN] Assigne manuellement un driver à une commande PENDING.
   * Met à jour Order, OrderStatusLog, et DriversStatus.
   * POST /admin/orders/:id/assign
   */
  async admin_assign_driver({ params, request, response, auth }: HttpContext) {
    await auth.check()
    const adminUser = auth.getUserOrFail() // Utilisateur Admin
    const orderId = params.id

    let payload
    try {
      payload = await request.validateUsing(assignDriverValidator)
    } catch (validationError) {
      logger.warn(
        { err: validationError },
        `Admin ${adminUser.id} failed assigning driver to order ${orderId} due to validation.`
      )
      return response.badRequest({
        message: 'Données invalides.',
        errors: validationError.messages,
      })
    }
    const { driver_id } = payload

    logger.info(
      `Admin ${adminUser.id} attempt manual assign Driver ${driver_id} to Order ${orderId}`
    )
    const trx = await db.transaction()

    try {
      const order = await Order.query({ client: trx })
        .where('id', orderId)
        .preload('pickup_address')
        .preload('packages')
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1))
        .first()

      if (!order) {
        await trx.rollback()
        return response.notFound({ message: `Commande ${orderId} non trouvée.` })
      }
      if (!order.pickup_address) {
        await trx.rollback()
        logger.error(`Order ${orderId} is missing pickup address for admin assignment.`)
        return response.internalServerError({
          message: 'Erreur: Adresse de départ manquante pour la commande.',
        })
      }

      const currentStatus = order.status_logs[0]?.status ?? null
      if (currentStatus !== OrderStatus.PENDING || order.driver_id) {
        await trx.rollback()
        logger.warn(
          `Admin ${adminUser.id} tried assign to non-pending/already-assigned Order ${orderId} (Status: ${currentStatus}, Driver: ${order.driver_id})`
        )
        return response.badRequest({
          message:
            "Cette commande n'est pas assignable (vérifiez son statut et si un livreur n'est pas déjà assigné).",
        })
      }
      const driver = await Driver.query({ client: trx })
        .where('id', driver_id)
        //@ts-ignore
        .preload('vehicles', (vQuery) => vQuery.where('status', VehicleStatus.ACTIVE)) // Seulement les véhicules actifs
        .first()

      if (!driver) {
        await trx.rollback()
        return response.notFound({ message: `Livreur ${driver_id} non trouvé.` })
      }

      const lastDriverStatus = await DriversStatus.query({ client: trx })
        .where('driver_id', driver_id)
        .orderBy('changed_at', 'desc')
        .first()

      if (lastDriverStatus?.status !== DriverStatus.ACTIVE) {
        await trx.rollback()
        return response.badRequest({
          message: `Le livreur ${driver_id} n'est pas ACTIF (Statut: ${lastDriverStatus?.status ?? 'inconnu'}).`,
        })
      }
      if (!order.packages || order.packages.length === 0) {
        await trx.rollback()
        logger.error(`Order ${orderId} has no package details for vehicle check.`)
        return response.internalServerError({ message: 'Erreur: Détails colis manquants.' })
      }
      const totalWeightG = order.packages.reduce(
        (sum, pkg) => sum + (pkg.dimensions?.weight_g || 0) * (pkg.quantity || 1),
        0
      )
      // TODO: Calculer volume, vérifier 'frigo_needed' etc.

      const hasSuitableVehicle =
        driver.vehicles.length > 0 &&
        driver.vehicles.some(
          (vehicle) => vehicle.max_weight_kg === null || vehicle.max_weight_kg >= totalWeightG // Poids OK
        )

      if (!hasSuitableVehicle) {
        await trx.rollback()
        logger.warn(
          `Driver ${driver_id} does not have a suitable active vehicle for Order ${orderId} (Weight: ${totalWeightG}g).`
        )
        return response.badRequest({
          message: `Le livreur ${driver_id} n'a pas de véhicule actif approprié pour cette commande.`,
        })
      }
      logger.info(
        `Driver ${driver_id} availability and vehicle check PASSED for manual assign Order ${orderId}.`
      )
      order.driver_id = driver_id

      if (!driver?.fcm_token) {
        await trx.rollback()
        logger.warn(`Driver ${driver_id} assigné mais n'a pas de FCM Token pour être notifié.`)
        return response.badRequest({
          message: `Le livreur ${driver_id} ne peut pas être assigné car il n'a pas de jeton FCM.`,
        })
      }
      try {
        const notifTitle = 'Nouvelle Mission Assignée'
        const notifBody = `Une course (ID: #${orderId.substring(0, 6)}...) vous a été assignée manuellement par un administrateur.`
        const notifData = { type: 'ADMIN_ASSIGNMENT', orderId: orderId }
        await redis_helper.enqueuePushNotification(
          driver.fcm_token,
          notifTitle,
          notifBody,
          notifData
        )
        logger.info(`Notification d'assignation manuelle envoyée au driver ${driver_id}.`)
      } catch (notifError) {
        await trx.rollback()
        logger.error(
          { err: notifError, orderId, driver_id },
          'Failed to send admin assignment notification.'
        )
        return response.internalServerError({
          message: 'Échec de l’envoi de la notification au livreur.',
        })
      }

      const logLocation = order.pickup_address.coordinates ?? { type: 'Point', coordinates: [0, 0] }
      await OrderStatusLog.create(
        {
          id: cuid(),
          order_id: orderId,
          status: OrderStatus.ACCEPTED, // Statut devient ACCEPTED
          changed_at: DateTime.now(),
          changed_by_user_id: adminUser.id, // L'admin initie ce statut
          metadata: { reason: 'assigned_by_admin' }, // Metadata indiquant l'origine
          current_location: logLocation,
        },
        { client: trx }
      )
      logger.info(
        `OrderStatusLog created with ACCEPTED status for Order ${orderId} by Admin ${adminUser.id}.`
      )
      //Mettre à jour Statut Driver -> IN_WORK
      const currentAssignments = lastDriverStatus?.assignments_in_progress_count ?? 0
      await DriversStatus.create(
        {
          id: cuid(),
          driver_id,
          status: DriverStatus.IN_WORK,
          changed_at: DateTime.now(),
          assignments_in_progress_count: currentAssignments + 1,
        },
        { client: trx }
      )
      logger.info(
        `Driver ${driver_id} status set to IN_WORK for manual assignment of Order ${orderId}`
      )
      await order.save() // Sauvegarde le driver_id via trx
      // 10. Commit Transaction
      await trx.commit()

      logger.info(
        `Order ${orderId} manually assigned to driver ${driver_id} by admin ${adminUser.id} - COMMITTED.`
      )

      // 11. Recharger les relations pour la réponse finale
      //@ts-ignore
      await order.load('driver', (q) => q.preload('user', (u) => u.select(['id', 'full_name'])))
      await order.load('status_logs', (q) =>
        q
          .orderBy('changed_at', 'desc')
          .limit(5)
          //@ts-ignore
          .preload('changed_by_user', (u) => u.select(['id', 'full_name', 'role']))
      ) // Récent historique
      await order.load('pickup_address')
      await order.load('delivery_address')
      await order.load('packages')

      return response.ok({
        message: `Livreur ${driver_id} assigné avec succès à la commande ${orderId}.`,
        order: order.serialize(),
      })
    } catch (error) {
      if (!trx.isCompleted) {
        // Rollback si pas déjà fait
        await trx.rollback()
      }
      logger.error(
        { err: error, orderId, driver_id, adminId: adminUser.id },
        'Erreur globale assignation admin'
      )

      if (error.code === 'E_VALIDATION_ERROR') {
        // Devrait être attrapé plus tôt
        return response.badRequest({ message: 'Données invalides.', errors: error.messages })
      }
      if (error.status) {
        // Si une erreur HTTP a été lancée dans le try
        return response.status(error.status).send({ message: error.message })
      }
      if (error.code === 'E_ROW_NOT_FOUND') {
        return response.notFound({ message: "Commande ou Livreur non trouvé pendant l'opération." })
      }
      // Autres erreurs
      return response.internalServerError({ message: "Erreur serveur lors de l'assignation." })
    }
  } // Fin admin_assign_driver

  async admin_cancel_order({ params, request, response, auth }: HttpContext) {
    const adminCancelOrderValidator = vine.compile(
      vine.object({
        // Utiliser l'enum de base ou un enum étendu
        reason_code: vine.enum(CancellationReasonCode), // Ou AdminCancellationReasonCode
        // Rendre les détails obligatoires si la raison est 'OTHER' ou une raison admin spécifique?
        reason_details: vine
          .string()
          .trim()
          .minLength(5)
          .optional()
          .requiredWhen('reason_code', 'in', ['OTHER']),
      })
    )
    await auth.check()
    const adminUser = auth.getUserOrFail() // Admin authentifié
    const orderId = params.id

    // 1. Valider la raison de l'annulation fournie par l'admin
    let payload
    try {
      payload = await request.validateUsing(adminCancelOrderValidator)
    } catch (validationError) {
      logger.warn(
        { err: validationError },
        `Admin ${adminUser.id} failed canceling order ${orderId} due to validation.`
      )
      return response.badRequest({
        message: 'Données invalides.',
        errors: validationError.messages,
      })
    }
    const { reason_code, reason_details } = payload // reason_details peut être null

    logger.info(
      `Admin ${adminUser.id} attempting to cancel Order ${orderId} with reason: ${reason_code}`
    )
    const trx = await db.transaction()

    try {
      // 2. Trouver la commande et précharger les infos utiles (DANS transaction)
      const order = await Order.query({ client: trx })
        .where('id', orderId)
        // Précharger le driver si assigné pour notification et mise à jour statut
        //@ts-ignore
        .preload('driver', (q) => q.select(['id', 'fcm_token']))
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1)) // Dernier statut actuel
        .first()

      if (!order) {
        await trx.rollback()
        return response.notFound({ message: `Commande ${orderId} non trouvée.` })
      }

      // 3. Vérifier si elle n'est pas DEJA terminée ou annulée
      const currentStatus = order.status_logs[0]?.status ?? null
      if (
        currentStatus === OrderStatus.SUCCESS ||
        currentStatus === OrderStatus.FAILED ||
        currentStatus === OrderStatus.CANCELLED
      ) {
        await trx.rollback()
        logger.warn(
          `Admin ${adminUser.id} tried to cancel already finished/cancelled Order ${orderId} (Status: ${currentStatus})`
        )
        return response.badRequest({
          message: `Impossible d'annuler une commande déjà terminée ou annulée (Statut: ${currentStatus}).`,
        })
      }

      // --- Logique d'Annulation ---

      // 4. Créer le nouveau log d'état -> CANCELLED
      // Prend la dernière localisation connue de la commande ou celle du pickup par défaut
      const lastKnownLocation = order.status_logs[0]?.current_location ??
        order.pickup_address?.coordinates ?? { type: 'Point', coordinates: [0, 0] }
      await OrderStatusLog.create(
        {
          id: cuid(),
          order_id: orderId,
          status: OrderStatus.CANCELLED, // <- Nouvel état
          changed_at: DateTime.now(),
          changed_by_user_id: adminUser.id, // <- Initié par l'Admin
          current_location: lastKnownLocation,
          metadata: {
            // Ajouter la raison de l'annulation aux metadata
            reason: reason_code,
            details: reason_details ?? undefined, // Ne met pas 'details' si null
          },
        },
        { client: trx }
      )
      logger.info(`OrderStatusLog CANCELLED created for Order ${orderId} by Admin ${adminUser.id}.`)

      // 5. Mettre à jour la commande (raison et retirer driver si nécessaire ?)
      // La colonne Order.status n'existant pas, on met juste la raison
      order.cancellation_reason_code = reason_code
      // order.cancellation_details = reason_details; // Si champ existe
      await order.save() // Sauve la raison d'annulation

      // 6. --- SI UN DRIVER ÉTAIT ASSIGNÉ ---
      // Mettre à jour son statut s'il était en mission
      const assignedDriverId = order.driver_id // Peut être null
      const wasInProgress = [
        OrderStatus.ACCEPTED,
        OrderStatus.AT_PICKUP,
        OrderStatus.EN_ROUTE_TO_DELIVERY,
        OrderStatus.AT_DELIVERY_LOCATION,
      ].includes(currentStatus!) // Le '!' est ok car on a vérifié non terminé/annulé

      if (assignedDriverId && wasInProgress) {
        logger.info(
          `Order ${orderId} cancelled by admin while Driver ${assignedDriverId} was working on it (Status: ${currentStatus}). Updating driver status.`
        )

        const lastDriverStatus = await DriversStatus.query({ client: trx })
          .where('driver_id', assignedDriverId)
          .orderBy('changed_at', 'desc')
          .first()

        if (lastDriverStatus && lastDriverStatus.status === DriverStatus.IN_WORK) {
          const newAssignmentCount = Math.max(
            0,
            (lastDriverStatus.assignments_in_progress_count || 1) - 1
          )
          const nextDriverStatus =
            newAssignmentCount === 0 ? DriverStatus.ACTIVE : DriverStatus.IN_WORK

          await DriversStatus.create(
            {
              id: cuid(),
              driver_id: assignedDriverId,
              status: nextDriverStatus,
              changed_at: DateTime.now(),
              assignments_in_progress_count: newAssignmentCount,
            },
            { client: trx }
          )
          logger.info(
            `Driver ${assignedDriverId} status updated to ${nextDriverStatus} after admin cancel.`
          )

          // Notifier le Driver TRES clairement de l'annulation par l'admin
          if (order.driver?.fcm_token) {
            // Utilise la relation préchargée
            try {
              await redis_helper.enqueuePushNotification(
                order.driver.fcm_token,
                'Mission Annulée (Admin)',
                `La course #${orderId.substring(0, 6)}... a été annulée par un administrateur. Raison: ${reason_code}. Arrêtez votre progression.`,
                { orderId: orderId, status: OrderStatus.CANCELLED, reason: reason_code }
              )
            } catch (notifError) {
              logger.error(
                { err: notifError, orderId, driverId: assignedDriverId },
                'Failed admin cancel notification to driver.'
              )
            }
          } else {
            logger.warn(
              `Assigned driver ${assignedDriverId} for cancelled order ${orderId} has no FCM token!`
            )
          }
        } else {
          logger.warn(
            `Assigned driver ${assignedDriverId} status was not IN_WORK (${lastDriverStatus?.status}) during admin cancel. No status update needed.`
          )
        }
      } // Fin si driver assigné et en cours

      // TODO: Gérer le remboursement client si nécessaire (via event ?)
      // TODO: Log Audit de l'action admin

      // 7. Commit Transaction
      await trx.commit()

      logger.info(`Order ${orderId} cancelled successfully by Admin ${adminUser.id}`)

      // 8. Réponse Succès
      // Recharger les logs pour inclure le log CANCELLED
      await order.preload('status_logs', (q) =>
        //@ts-ignore
        q.orderBy('changed_at', 'desc').limit(5).preload('changed_by_user')
      )

      return response.ok({
        message: "Commande annulée avec succès par l'administrateur.",
        order: order.serialize({ fields: { omit: ['confirmation_code'] } }), // Toujours pas de code confirmation
      })
    } catch (error) {
      if (!trx.isCompleted) await trx.rollback() // Rollback si échec
      logger.error(
        { err: error, orderId, adminId: adminUser.id },
        'Erreur lors annulation commande admin'
      )

      if (error.code === 'E_VALIDATION_ERROR') {
        // Attrapé plus tôt normalement
        return response.badRequest({ message: 'Données invalides.', errors: error.messages })
      }
      if (error.status) {
        // Erreur lancée manuellement (400, 404)
        return response.status(error.status).send({ message: error.message })
      }
      if (error.code === 'E_ROW_NOT_FOUND') {
        // Si find() échoue
        return response.notFound({ message: 'Commande non trouvée.' })
      }
      // Autres erreurs serveur
      return response.internalServerError({ message: "Erreur serveur lors de l'annulation." })
    }
  } // Fin admin_cancel_order

  /**
   * [ADMIN] Marque manuellement une commande comme SUCCESS (Livrée).
   * Déclenche le paiement Driver via événement Redis.
   * PATCH /admin/orders/:id/mark-success
   */
  async admin_mark_as_success({ params, request, response, auth }: HttpContext) {
    const adminMarkSuccessValidator = vine.compile(
      vine.object({
        success_reason_code: vine.enum(CancellationReasonCode), // New enum
        reason_details: vine
          .string()
          .trim()
          .minLength(5)
          .optional()
          .requiredWhen('success_reason_code', 'in', ['OTHER']),
      })
    )
    await auth.check()
    const adminUser = auth.getUserOrFail()
    const orderId = params.id

    let payload
    try {
      payload = await request.validateUsing(adminMarkSuccessValidator)
    } catch (validationError) {
      logger.warn(
        { err: validationError },
        `Admin ${adminUser.id} failed validating mark SUCCESS for order ${orderId}`
      )
      return response.badRequest({
        message: 'Données invalides.',
        errors: validationError.messages,
      })
    }
    const { success_reason_code, reason_details } = payload

    logger.info(
      `Admin ${adminUser.id} attempting to mark Order ${orderId} as SUCCESS with reason: ${success_reason_code}`
    )
    const trx = await db.transaction()

    try {
      // Retrieve order
      const order = await Order.query({ client: trx })
        .where('id', orderId)
        //@ts-ignore
        .preload('driver', (q) => q.preload('user', (u) => u.select(['id', 'fcm_token'])))
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1))
        .preload('pickup_address')
        .preload('delivery_address')
        .first()

      if (!order) {
        await trx.rollback()
        return response.notFound({ message: `Commande ${orderId} non trouvée.` })
      }

      // Check status
      const currentStatus = order.status_logs[0]?.status ?? null
      if (
        currentStatus === OrderStatus.SUCCESS ||
        currentStatus === OrderStatus.FAILED ||
        currentStatus === OrderStatus.CANCELLED
      ) {
        await trx.rollback()
        logger.warn(
          `Admin ${adminUser.id} tried to mark SUCCESS on already finished/cancelled Order ${orderId} (Status: ${currentStatus})`
        )
        return response.badRequest({
          message: `Impossible de marquer une commande déjà terminée ou annulée (Statut: ${currentStatus}).`,
        })
      }

      // Success logic
      const assignedDriverId = order.driver_id
      const wasInProgress =
        assignedDriverId &&
        [
          OrderStatus.ACCEPTED,
          OrderStatus.AT_PICKUP,
          OrderStatus.EN_ROUTE_TO_DELIVERY,
          OrderStatus.AT_DELIVERY_LOCATION,
        ].includes(currentStatus)

      // Create OrderStatusLog
      const lastKnownLocation = order.status_logs[0]?.current_location ??
        order.delivery_address?.coordinates ?? // Prefer delivery_address for SUCCESS
        order.pickup_address?.coordinates ?? { type: 'Point', coordinates: [0, 0] }
      await OrderStatusLog.create(
        {
          id: cuid(),
          order_id: orderId,
          status: OrderStatus.SUCCESS,
          changed_at: DateTime.now(),
          changed_by_user_id: adminUser.id,
          current_location: lastKnownLocation,
          metadata: {
            reason: success_reason_code,
            details: reason_details ?? undefined,
          },
        },
        { client: trx }
      )
      logger.info(`OrderStatusLog SUCCESS created for Order ${orderId} by Admin ${adminUser.id}.`)

      // Driver handling
      if (wasInProgress) {
        logger.info(
          `Order ${orderId} marked SUCCESS by admin. Updating driver ${assignedDriverId} status and triggering payment.`
        )
        const lastDriverStatus = await DriversStatus.query({ client: trx })
          .where('driver_id', assignedDriverId)
          .orderBy('changed_at', 'desc')
          .first()
        if (lastDriverStatus?.status === DriverStatus.IN_WORK) {
          const newAssignmentCount = Math.max(
            0,
            (lastDriverStatus.assignments_in_progress_count || 1) - 1
          )
          const nextDriverStatus =
            newAssignmentCount === 0 ? DriverStatus.ACTIVE : DriverStatus.IN_WORK
          await DriversStatus.create(
            {
              id: cuid(),
              driver_id: assignedDriverId,
              status: nextDriverStatus,
              changed_at: DateTime.now(),
              assignments_in_progress_count: newAssignmentCount,
            },
            { client: trx }
          )
          logger.info(
            `Driver ${assignedDriverId} status updated to ${nextDriverStatus} after admin success.`
          )

          // Notify driver
          if (order.driver?.fcm_token) {
            try {
              await redis_helper.enqueuePushNotification(
                order.driver.fcm_token,
                'Mission Réussie (Admin)',
                `La course #${orderId.substring(0, 6)}... a été marquée comme réussie. Raison: ${success_reason_code}${reason_details ? ` (${reason_details})` : ''}.`,
                { orderId, status: OrderStatus.SUCCESS, reason: success_reason_code }
              )
              logger.info(
                `Notification sent to driver ${assignedDriverId} for successful order ${orderId}.`
              )
            } catch (notifError) {
              logger.error(
                { err: notifError, orderId, driverId: assignedDriverId },
                'Failed admin success notification to driver.'
              )
            }
          } else {
            logger.warn(
              `Assigned driver ${assignedDriverId} for successful order ${orderId} has no FCM token.`
            )
          }
        }

        // Trigger payment
        try {
          const paymentEventId = await RedisHelper.publishMissionCompleted(
            orderId,
            assignedDriverId,
            order.remuneration
          )
          logger.info(
            `Payment event published for Order ${orderId}, Driver ${assignedDriverId}. Event ID: ${paymentEventId || 'none'}`
          )
        } catch (redisError) {
          logger.error(
            { err: redisError, orderId, driverId: assignedDriverId },
            'Failed to publish payment event for successful order.'
          )
        }
      } else if (assignedDriverId) {
        logger.info(
          `Order ${orderId} marked SUCCESS by admin. Driver ${assignedDriverId} was assigned but status was ${currentStatus}. Triggering payment.`
        )
        // Trigger payment for assigned driver
        try {
          const paymentEventId = await RedisHelper.publishMissionCompleted(
            orderId,
            assignedDriverId,
            order.remuneration
          )
          logger.info(
            `Payment event published for Order ${orderId}, Driver ${assignedDriverId}. Event ID: ${paymentEventId || 'none'}`
          )
        } catch (redisError) {
          logger.error(
            { err: redisError, orderId, driverId: assignedDriverId },
            'Failed to publish payment event for successful order.'
          )
        }
      } else {
        logger.info(`Order ${orderId} marked SUCCESS by admin. No driver was assigned.`)
      }

      // Update order
      order.failure_reason_code = null
      order.cancellation_reason_code = null
      // order.success_reason_code = success_reason_code; // Uncomment if field exists
      await order.save()

      // Commit
      await trx.commit()
      logger.info(`Order ${orderId} marked as SUCCESS by Admin ${adminUser.id} - COMMITTED.`)

      // Response
      await order.load('status_logs', (q) =>
        //@ts-ignore
        q.orderBy('changed_at', 'desc').limit(5).preload('changed_by_user')
      )
      if (assignedDriverId) await order.load('driver')
      return response.ok({
        message: `Commande marquée comme réussie avec succès par l'administrateur.`,
        order: order.serialize({ fields: { omit: ['confirmation_code'] } }),
      })
    } catch (error) {
      if (!trx.isCompleted) await trx.rollback()
      logger.error(
        { err: error, orderId, adminId: adminUser.id },
        'Erreur lors marquage commande SUCCESS admin'
      )
      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({ message: 'Données invalides.', errors: error.messages })
      }
      if (error.status) {
        return response.status(error.status).send({ message: error.message })
      }
      if (error.code === 'E_ROW_NOT_FOUND') {
        return response.notFound({ message: 'Commande non trouvée.' })
      }
      return response.internalServerError({
        message: 'Erreur serveur lors du marquage comme réussi.',
      })
    }
  }

  /**
   * [ADMIN] Marque manuellement une commande comme FAILED (Échouée).
   * Met à jour les stats driver et vérifie potentiel besoin de suspension (conceptuel).
   * PATCH /admin/orders/:id/mark-failed
   */
  async admin_mark_as_failed({ params, request, response, auth }: HttpContext) {
    const adminMarkFailedValidator = vine.compile(
      vine.object({
        failure_reason_code: vine.enum(FailureReasonCode), // Use FailureReasonCode enum
        reason_details: vine
          .string()
          .trim()
          .minLength(5)
          .optional()
          .requiredWhen('failure_reason_code', 'in', ['OTHER']),
      })
    )
    await auth.check()
    const adminUser = auth.getUserOrFail()
    const orderId = params.id

    let payload
    try {
      payload = await request.validateUsing(adminMarkFailedValidator)
    } catch (validationError) {
      logger.warn(
        { err: validationError },
        `Admin ${adminUser.id} failed validating mark FAILED for order ${orderId}`
      )
      return response.badRequest({
        message: 'Données invalides.',
        errors: validationError.messages,
      })
    }
    const { failure_reason_code, reason_details } = payload

    logger.info(
      `Admin ${adminUser.id} attempting to mark Order ${orderId} as FAILED with reason: ${failure_reason_code}`
    )
    const trx = await db.transaction()

    try {
      // Retrieve order
      const order = await Order.query({ client: trx })
        .where('id', orderId)
        //@ts-ignore
        .preload('driver', (q) => q.preload('user', (u) => u.select(['id', 'fcm_token'])))
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1))
        .preload('pickup_address')
        .preload('delivery_address')
        .first()

      if (!order) {
        await trx.rollback()
        return response.notFound({ message: `Commande ${orderId} non trouvée.` })
      }

      // Check status
      const currentStatus = order.status_logs[0]?.status ?? null
      if (
        currentStatus === OrderStatus.SUCCESS ||
        currentStatus === OrderStatus.FAILED ||
        currentStatus === OrderStatus.CANCELLED
      ) {
        await trx.rollback()
        logger.warn(
          `Admin ${adminUser.id} tried to mark FAILED on already finished/cancelled Order ${orderId} (Status: ${currentStatus})`
        )
        return response.badRequest({
          message: `Impossible de marquer une commande déjà terminée ou annulée (Statut: ${currentStatus}).`,
        })
      }

      // Failure logic
      const assignedDriverId = order.driver_id
      const wasInProgress =
        assignedDriverId &&
        [
          OrderStatus.ACCEPTED,
          OrderStatus.AT_PICKUP,
          OrderStatus.EN_ROUTE_TO_DELIVERY,
          OrderStatus.AT_DELIVERY_LOCATION,
        ].includes(currentStatus!)

      // Create OrderStatusLog
      const lastKnownLocation = order.status_logs[0]?.current_location ??
        order.pickup_address?.coordinates ?? // Prefer pickup_address
        order.delivery_address?.coordinates ?? { type: 'Point', coordinates: [0, 0] }
      await OrderStatusLog.create(
        {
          id: cuid(),
          order_id: orderId,
          status: OrderStatus.FAILED,
          changed_at: DateTime.now(),
          changed_by_user_id: adminUser.id,
          current_location: lastKnownLocation,
          metadata: {
            reason: failure_reason_code,
            details: reason_details ?? undefined,
          },
        },
        { client: trx }
      )
      logger.info(`OrderStatusLog FAILED created for Order ${orderId} by Admin ${adminUser.id}.`)

      // Driver handling
      if (wasInProgress) {
        logger.info(
          `Order ${orderId} marked FAILED by admin. Updating driver ${assignedDriverId} status.`
        )
        const lastDriverStatus = await DriversStatus.query({ client: trx })
          .where('driver_id', assignedDriverId)
          .orderBy('changed_at', 'desc')
          .first()
        if (lastDriverStatus?.status === DriverStatus.IN_WORK) {
          const newAssignmentCount = Math.max(
            0,
            (lastDriverStatus.assignments_in_progress_count || 1) - 1
          )
          const nextDriverStatus =
            newAssignmentCount === 0 ? DriverStatus.ACTIVE : DriverStatus.IN_WORK
          await DriversStatus.create(
            {
              id: cuid(),
              driver_id: assignedDriverId,
              status: nextDriverStatus,
              changed_at: DateTime.now(),
              assignments_in_progress_count: newAssignmentCount,
            },
            { client: trx }
          )
          logger.info(
            `Driver ${assignedDriverId} status updated to ${nextDriverStatus} after admin failure.`
          )

          // TODO: Record driver stats
          // await DriverStatsService.recordFailure(assignedDriverId, failure_reason_code);

          // TODO: Check driver suspension
          // await checkDriverSuspension(assignedDriverId, failure_reason_code);

          // Notify driver
          if (order.driver?.fcm_token) {
            try {
              await redis_helper.enqueuePushNotification(
                order.driver.fcm_token,
                'Mission Échouée (Admin)',
                `La course #${orderId.substring(0, 6)}... a été marquée comme échouée. Raison: ${failure_reason_code}${reason_details ? ` (${reason_details})` : ''}. Aucun action supplémentaire requise.`,
                { orderId, status: OrderStatus.FAILED, reason: failure_reason_code }
              )
              logger.info(
                `Notification sent to driver ${assignedDriverId} for failed order ${orderId}.`
              )
            } catch (notifError) {
              logger.error(
                { err: notifError, orderId, driverId: assignedDriverId },
                'Failed admin failure notification to driver.'
              )
            }
          } else {
            logger.warn(
              `Assigned driver ${assignedDriverId} for failed order ${orderId} has no FCM token.`
            )
          }
        }
      } else if (assignedDriverId) {
        logger.info(
          `Order ${orderId} marked FAILED by admin. Driver ${assignedDriverId} was assigned but status was ${currentStatus}. No status update needed.`
        )
        // TODO: Optionally record stats
        const driver = await Driver.findOrFail(assignedDriverId)
        driver.delivery_stats.failure += 1
        await driver.save()
        // await DriverStatsService.recordFailure(assignedDriverId, failure_reason_code);
      } else {
        logger.info(`Order ${orderId} marked FAILED by admin. No driver was assigned.`)
      }

      // Update order
      order.failure_reason_code = failure_reason_code
      // order.failure_details = reason_details; // Uncomment if field exists
      await order.save()

      // Commit
      await trx.commit()
      logger.info(`Order ${orderId} marked as FAILED by Admin ${adminUser.id} - COMMITTED.`)

      // Response
      await order.load('status_logs', (q) =>
        //@ts-ignore
        q.orderBy('changed_at', 'desc').limit(5).preload('changed_by_user')
      )
      if (assignedDriverId) await order.load('driver')
      return response.ok({
        message: `Commande marquée comme échouée avec succès par l'administrateur.`,
        order: order.serialize({ fields: { omit: ['confirmation_code'] } }),
      })
    } catch (error) {
      if (!trx.isCompleted) await trx.rollback()
      logger.error(
        { err: error, orderId, adminId: adminUser.id },
        'Erreur lors marquage commande FAILED admin'
      )
      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({ message: 'Données invalides.', errors: error.messages })
      }
      if (error.status) {
        return response.status(error.status).send({ message: error.message })
      }
      if (error.code === 'E_ROW_NOT_FOUND') {
        return response.notFound({ message: 'Commande non trouvée.' })
      }
      return response.internalServerError({
        message: 'Erreur serveur lors du marquage comme échoué.',
      })
    }
  }
  // TODO: Ajouter potentiellement [ADMIN] admin_mark_delivered / admin_mark_failed pour résoudre les litiges (met à jour Order.status, reason_code, User.is_valid_driver si échec répété?)
} // Fin du contrôleur
