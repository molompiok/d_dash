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
const OFFER_DURATION_SECONDS = env.get('DRIVER_OFFER_DURATION_SECONDS')
// --- Import des Helpers/Wrappers (chemins à adapter) ---
import { SimplePackageInfo } from '#services/pricing_helper' // Fonction calculateFees
import RedisHelper, { RawInitialAssignmentDetails } from '#services/redis_helper' // Fonction publishMissionOffer
// --- Fin Imports Helpers ---

// --- Import des Validateurs ---
import vine from '@vinejs/vine'
import OrderStatusLog from '#models/order_status_log'
import env from '#start/env'
import Client from '#models/client'
import redis_helper from '#services/redis_helper'
import { NotificationType } from '#models/notification'
import geo_helper from '#services/geo_helper'
import pricing_helper from '#services/pricing_helper'
import OrderRouteLeg from '#models/order_route_leg'
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

const packageInfoValidator = vine.object({
  name: vine.string().trim().minLength(1),
  description: vine.string().trim().optional(),
  dimensions: packageDimensionsValidator.optional(),
  mention_warning: vine.enum(PackageMentionWarning).optional(),
  quantity: vine.number().min(1).positive(),
  // image_urls: vine.array(vine.string().url()).optional(), // Si tu gères les images
})

// Waypoint individuel
const waypointValidator = vine.object({
  address_text: vine.string().trim().minLength(5).maxLength(255),
  type: vine.enum(['pickup', 'delivery'] as const), // Important le 'as const' pour typer correctement
  // Les informations sur le colis ne sont requises que si type === 'pickup'
  // On ne peut pas faire de requiredWhen direct ici, la validation se fera en partie dans le contrôleur
  package_infos: vine.array(packageInfoValidator).optional(), // Rendre optionnel ici
  contact_name: vine.string().trim().optional(),
  contact_phone: vine.string().trim().optional(), // Ajouter validation de format si besoin
  note: vine.string().trim().optional(), // Note spécifique au waypoint
})

interface ValidatedWaypoint {
  address_text: string;
  type: 'pickup' | 'delivery';
  package_infos?: ValidatedPackageInfo;
  contact_name?: string;
  contact_phone?: string;
  note?: string;
}

interface ValidatedPackageInfo {
  name: string;
  description?: string;
  dimensions: {
    weight_g: number;
    depth_cm?: number;
    width_cm?: number;
    height_cm?: number;
  };
  mention_warning?: PackageMentionWarning;
  quantity: number;
}

export const createOrderWithWaypointsValidator = vine.compile(
  vine.object({
    waypoints: vine
      .array(waypointValidator)
      .minLength(2) // Au moins un pickup et une livraison
      .bail(false), // Continue la validation même si un waypoint est invalide pour voir toutes les erreurs
    priority: vine.enum(['low', 'medium', 'high'] as const).optional(), // Utilise OrderPriority enum
    global_order_note: vine.string().trim().optional(),
    // Tu pourrais ajouter ici d'autres champs globaux pour la commande
    // ex: requested_delivery_time_slot, etc.
  })
)

interface ProcessedWaypoint {
  id: string; // CUID généré pour ce waypoint traité (utile pour le résumé)
  original_payload: ValidatedWaypoint;
  address_model: Address;
  coordinates: [number, number]; // lon, lat
  type_for_valhalla: 'break' | 'through';
  package_infos_for_db?: Omit<Package, 'id' | 'order_id' | 'created_at' | 'updated_at' | 'is_return'>[]; // Pour créer les Package modèles
}

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
    const user = await auth.authenticate()
    await user.load('client')
    if (!user.client) {
      return response.forbidden({ message: 'Utilisateur non associé à un compte client.' })
    }
    const clientId = user.client.id

    const OFFER_DURATION_SECONDS = env.get('DRIVER_OFFER_DURATION_SECONDS')

    let payload
    try {
      payload = await request.validateUsing(createOrderWithWaypointsValidator)
      logger.info({ payload }, `Validation payload création commande client ${clientId}`)
    } catch (validationError) {
      logger.warn({ err: validationError.messages }, `Validation payload création commande client ${clientId}`)
      return response.badRequest({ message: 'Données de commande invalides.', errors: validationError.messages })
    }

    // Validation Manuelle Supplémentaire
    const pickupWaypoints = payload.waypoints.filter(wp => wp.type === 'pickup');
    const deliveryWaypoints = payload.waypoints.filter(wp => wp.type === 'delivery');

    if (pickupWaypoints.length === 0) {
      return response.badRequest({ message: 'Au moins un point de collecte est requis.' });
    }
    if (deliveryWaypoints.length === 0) {
      return response.badRequest({ message: 'Au moins un point de livraison est requis.' });
    }
    for (const wp of pickupWaypoints) {
      if (!wp.package_infos || wp.package_infos.length === 0) {
        return response.badRequest({
          message: `Les informations sur le colis sont requises pour le point de collecte : "${wp.address_text}".`
        });
      }
    }


    const trx = await db.transaction()
    let newOrder: Order | null = null

    try {
      // 1. Géocoder toutes les adresses des waypoints et les préparer
      const processedWaypoints: ProcessedWaypoint[] = []
      const allPackageInfosForDb: Omit<Package, | 'order_id' | 'created_at' | 'updated_at' | 'is_return'>[] = []

      for (const waypointPayload of payload.waypoints) {
        const geocoded = await geo_helper.geocodeAddress(waypointPayload.address_text)
        if (!geocoded) {
          await trx.rollback()
          logger.warn(`Géocodage échoué pour l'adresse: ${waypointPayload.address_text}`)
          return response.badRequest({ message: `L'adresse "${waypointPayload.address_text}" n'a pas pu être trouvée ou validée.` })
        }

        // Créer ou trouver l'Address model
        // Pour la simplicité, on crée toujours. En prod, tu voudrais vérifier si elle existe.
        const addressModel = await Address.create(
          {
            id: cuid(),
            street_address: waypointPayload.address_text,
            city: geocoded.city || 'N/A',
            postal_code: geocoded.postcode || 'N/A',
            country: geocoded.country_code || 'N/A',
            coordinates: { type: 'Point', coordinates: geocoded.coordinates },
            // address_details: JSON.stringify(geocoded.rawDetails) // Si tu veux stocker plus
          },
          { client: trx }
        )

        const processedWp: any = {
          id: cuid(), // ID unique pour ce waypoint traité
          original_payload: waypointPayload,
          address_model: addressModel,
          coordinates: geocoded.coordinates as [number, number],
          type_for_valhalla: 'break', // Tous les waypoints sont des arrêts
          package_infos_for_db: []
        };

        if (waypointPayload.type === 'pickup' && waypointPayload.package_infos && waypointPayload.package_infos.length > 0) {
          processedWp.package_infos_for_db = waypointPayload.package_infos.map(pkgInfo => {
            // pkgInfo est de type ValidatedPackageInfoItem
            return {
              id: cuid(),
              name: pkgInfo.name,
              description: pkgInfo.description,
              dimensions: pkgInfo.dimensions,
              mention_warning: pkgInfo.mention_warning,
              quantity: pkgInfo.quantity,
              image_urls: [], // pkgInfo.image_urls || [],
            };
          });
          allPackageInfosForDb.push(...processedWp.package_infos_for_db);
        }
        processedWaypoints.push(processedWp);
      }


      // 2. Créer l'Order de base
      // Le premier waypoint de type 'pickup' est considéré comme le pickup_address_id global.
      // Le dernier waypoint de type 'delivery' est le delivery_address_id global.
      const firstPickupProcessed = processedWaypoints.find(wp => wp.original_payload.type === 'pickup');
      const lastDeliveryProcessed = [...processedWaypoints].reverse().find(wp => wp.original_payload.type === 'delivery');

      if (!firstPickupProcessed || !lastDeliveryProcessed) {
        // Ne devrait pas arriver à cause des validations précédentes
        throw new Error("Logique de premier pickup / dernière livraison erronée.");
      }

      newOrder = new Order()
      newOrder.useTransaction(trx)
      const priority = (payload.priority || OrderPriority.MEDIUM) as OrderPriority
      newOrder.fill({
        id: cuid(),
        client_id: clientId,
        pickup_address_id: firstPickupProcessed.address_model.id,
        delivery_address_id: lastDeliveryProcessed.address_model.id,
        priority: priority,
        note_order: payload.global_order_note,
        client_fee: 500,
        remuneration: 500,
        delivery_date: DateTime.now().plus({ seconds: OFFER_DURATION_SECONDS }),
      })

      await newOrder.save()

      // 3. Préparer les waypoints pour GeoHelper.calculateOptimizedRoute
      // Ici, l'ordre des `processedWaypoints` est l'ordre fourni par le client.
      // Si tu as besoin d'optimiser cet ordre (TSP), c'est ici qu'il faudrait le faire.
      // Pour l'instant, on prend l'ordre tel quel.
      const waypointsForValhallaRoute = processedWaypoints.map((pwp, _index) => ({
        coordinates: pwp.coordinates,
        type: pwp.type_for_valhalla,
        address_id: pwp.address_model.id,
        address_text: pwp.original_payload.address_text,
        waypoint_type_for_summary: pwp.original_payload.type,
        package_name_for_summary: pwp.original_payload.type === 'pickup' && pwp.package_infos_for_db && pwp.package_infos_for_db.length > 0
          ? pwp.package_infos_for_db[0].name + (pwp.package_infos_for_db.length > 1 ? ` (+${pwp.package_infos_for_db.length - 1})` : '')
          : undefined,
      }));


      // 4. Calculer l'itinéraire et les legs
      const routeDetails = await geo_helper.calculateOptimizedRoute(waypointsForValhallaRoute)
      if (!routeDetails) {
        await trx.rollback()
        logger.error(`Impossible de calculer l'itinéraire pour la nouvelle commande ${newOrder.id}`)
        return response.internalServerError({ message: "Erreur lors du calcul de l'itinéraire." })
      }


      // 5. Mettre à jour l'Order avec les infos de route et calculer les frais
      newOrder.calculation_engine = routeDetails.calculation_engine
      newOrder.delivery_date_estimation = DateTime.now().plus({ seconds: routeDetails.global_summary.total_duration_seconds })
      newOrder.waypoints_summary = routeDetails.waypoints_summary_for_order || null; // Construit par GeoHelper

      const packageInfoForPricing = allPackageInfosForDb.map(pkg => ({
        name: pkg.name,
        dimensions: pkg.dimensions, // Assure-toi que dimensions est bien du type attendu
        quantity: pkg.quantity,
      }));

      const fees = await pricing_helper.calculateFees(
        routeDetails.global_summary.total_distance_meters,
        routeDetails.global_summary.total_duration_seconds,
        packageInfoForPricing as SimplePackageInfo[]
      );
      newOrder.client_fee = Math.round(fees.clientFee);
      newOrder.remuneration = Math.round(fees.driverRemuneration);
      await newOrder.save()


      // 6. Créer les OrderRouteLegs
      for (let i = 0; i < routeDetails.legs.length; i++) {
        const legDataFromHelper = routeDetails.legs[i];
        // Le leg `i` va de `waypointsForValhallaRoute[i]` à `waypointsForValhallaRoute[i+1]`
        const startWpForThisLeg = waypointsForValhallaRoute[i];
        const endWpForThisLeg = waypointsForValhallaRoute[i + 1];

        if (!startWpForThisLeg || !endWpForThisLeg) {
          logger.error(`Manque d'info waypoint pour le leg ${i} lors de la création OrderRouteLeg.`);
          // Gérer cette erreur critique, peut-être en annulant la transaction
          await trx.rollback();
          return response.internalServerError({ message: `Erreur interne lors de la construction de l'itinéraire (leg ${i}).` });
        }

        const orderRouteLeg = new OrderRouteLeg()
        orderRouteLeg.useTransaction(trx)
        orderRouteLeg.fill({
          order_id: newOrder.id,
          leg_sequence: i,
          geometry: legDataFromHelper.geometry,
          duration_seconds: legDataFromHelper.duration_seconds,
          distance_meters: legDataFromHelper.distance_meters,
          maneuvers: legDataFromHelper.maneuvers,
          raw_valhalla_leg_data: legDataFromHelper.raw_valhalla_leg_data,
          start_address_id: startWpForThisLeg.address_id, // Peut être null si le premier leg part du driver
          end_address_id: endWpForThisLeg.address_id,
          start_coordinates: { type: 'Point', coordinates: startWpForThisLeg.coordinates },
          end_coordinates: { type: 'Point', coordinates: endWpForThisLeg.coordinates },
        })
        await orderRouteLeg.save()
      }


      if (allPackageInfosForDb.length > 0) {
        const packagesToCreate = allPackageInfosForDb.map(pkgInfo => ({
          ...pkgInfo,
          order_id: newOrder!.id,
        }));
        await Package.createMany(packagesToCreate, { client: trx });
      } else if (payload.waypoints.some(wp => wp.type === 'pickup')) {
        // Sécurité: si on a des pickups mais aucun package n'a été préparé (devrait être attrapé par la validation manuelle)
        await trx.rollback();
        logger.error(`Logique d'erreur: des pickups étaient présents mais aucun package n'a été préparé pour la commande ${newOrder?.id}`);
        return response.internalServerError({ message: "Erreur lors de la préparation des informations des colis." });
      }


      // 8. Créer le Log PENDING initial
      const firstPickupCoordinates = firstPickupProcessed.address_model.coordinates;
      await OrderStatusLog.create({
        id: cuid(),
        order_id: newOrder.id,
        status: OrderStatus.PENDING,
        changed_at: newOrder.created_at,
        changed_by_user_id: user.id,
        current_location: firstPickupCoordinates, // Optionnel, mais peut être utile
      },
        { client: trx }
      )


      await trx.commit()

      try {
        const orderForEvent = newOrder! // newOrder est non null ici
        const firstPickupProcessed = processedWaypoints.find(wp => wp.original_payload.type === 'pickup'); // Déjà calculé
        const totalWeightG = allPackageInfosForDb.reduce( // Déjà calculé
          (sum, pkg) => sum + (pkg.dimensions?.weight_g || 0) * (pkg.quantity || 1), 0
        );

        const assignmentDetails: RawInitialAssignmentDetails = {
          // S'assurer que firstPickupWaypointData et ses coordonnées existent
          pickupCoordinates: firstPickupProcessed?.coordinates,
          totalWeightG: totalWeightG, // Assurez-vous que totalWeightG est bien calculé et disponible ici
          initialRemuneration: orderForEvent.remuneration
        };
        await redis_helper.publishNewOrderReadyForAssignment(
          orderForEvent.id,
          assignmentDetails
        );
        logger.info(`Event NEW_ORDER_READY_FOR_ASSIGNMENT published for Order ${orderForEvent.id}`);
      } catch (eventError) {
        logger.error({ err: eventError, orderId: newOrder!.id }, "Failed to publish NEW_ORDER_READY_FOR_ASSIGNMENT event.");
        // La commande est créée, AssignmentWorker la prendra via son scan, mais avec un délai.
      }

      // 10. Réponse au client
      await newOrder.load(loader => {
        loader.load('pickup_address') // Adresse globale
          .load('delivery_address') // Adresse globale
          .load('packages')
          .load('route_legs', q => q.orderBy('leg_sequence', 'asc'))
      })

      const message = "Commande créée. Recherche d'un livreur en cours..."

      return response.created({
        message: message,
        order: newOrder.serialize({
          fields: { omit: ['confirmation_delivery_code', 'confirmation_pickup_code'] },
          relations: {
            route_legs: {
              fields: {
                pick: ['leg_sequence', 'duration_seconds', 'distance_meters', 'geometry', 'maneuvers', 'start_coordinates', 'end_coordinates']
              }
            },
            packages: { fields: { pick: ['name', 'quantity', 'dimensions'] } },
            // pickup_address et delivery_address seront sérialisés par défaut
          }
        }),
      })

    } catch (error) {
      if (trx.isCompleted === false && trx.isTransaction === false) { // Vérifier si la transaction est toujours active
        await trx.rollback()
      }
      logger.error({ err: error, clientId }, 'Erreur globale création commande avec waypoints')
      return response.internalServerError({ message: error.message || 'Erreur serveur lors de la création de la commande.' })
    }
  }

  // ... La méthode rerouteOrderLeg reste similaire à la version précédente ...
  // Assure-toi d'importer et d'utiliser rerouteLegValidator
  async reroute_order_leg({ request, response, params, auth }: HttpContext) {
    const rerouteLegValidator = vine.compile(
      vine.object({
        current_location: vine.object({
          latitude: vine.number().min(-90).max(90),
          longitude: vine.number().min(-180).max(180),
        }),
        // Optionnel: tu pourrais ajouter costing_model si le driver peut changer de mode
        // costing_model: vine.enum(['auto', 'bicycle', 'pedestrian']).optional()
      })
    )
    // const user = auth.getUserOrFail(); // Utilise si tu as besoin d'identifier le driver
    await auth.check();


    let payload;
    try {
      payload = await request.validateUsing(rerouteLegValidator);
    } catch (validationError) {
      logger.warn({ err: validationError.messages }, 'Validation rerouteLeg failed');
      return response.badRequest({ message: 'Données invalides.', errors: validationError.messages });
    }

    const { order_id, legSequence: legSequenceParam } = params;
    const legSequence = parseInt(legSequenceParam, 10);

    if (isNaN(legSequence) || legSequence < 0) {
      return response.badRequest({ message: 'Numéro de séquence du leg invalide.' });
    }

    try {
      const order = await Order.query()
        .where('id', order_id)
        // Optionnel : .where('driver_id', user.driver.id) si le reroutage est initié par le driver assigné
        .preload('route_legs', (query) => { // Précharge tous les legs pour trouver celui qui nous intéresse
          query.orderBy('leg_sequence', 'asc');
        })
        .firstOrFail(); // Lance une exception si non trouvé

      const targetLeg = order.route_legs.find(leg => leg.leg_sequence === legSequence);

      logger.info({ current_location: payload.current_location }, 'current_location ⛔⛔⛔⛔⛔');

      if (!targetLeg || !targetLeg.end_coordinates) {
        return response.notFound({ message: `Leg ${legSequence} non trouvé ou destination manquante pour la commande ${order_id}.` });
      }

      const driverCurrentLocation: [number, number] = [
        payload.current_location.longitude,
        payload.current_location.latitude,
      ];
      const legDestinationCoordinates: [number, number] = [
        targetLeg.end_coordinates.coordinates[0], // lon
        targetLeg.end_coordinates.coordinates[1], // lat
      ];

      // logger.info({ driverCurrentLocation, legDestinationCoordinates }, 'RerouteLeg');

      const reroutedLegData = await geo_helper.rerouteLeg(
        driverCurrentLocation,
        legDestinationCoordinates
      );

      if (!reroutedLegData) {
        logger.error(`Échec du reroutage pour Order ${order_id}, Leg ${legSequence}`);
        return response.internalServerError({ message: 'Impossible de recalculer l\'itinéraire pour ce segment.' });
      }

      // logger.info({ reroutedLegData }, 'RerouteLeg');

      return response.ok({
        message: 'Segment d\'itinéraire recalculé.',
        order_id: order_id,
        leg_sequence: legSequence,
        rerouted_leg: {
          geometry: reroutedLegData.geometry,
          duration_seconds: reroutedLegData.duration_seconds,
          distance_meters: reroutedLegData.distance_meters,
          maneuvers: reroutedLegData.maneuvers,
        },
      });

    } catch (error) {
      logger.error({ err: error, order_id, legSequence }, 'Erreur lors du reroutage du leg');
      if (error.code === 'E_ROW_NOT_FOUND') {
        return response.notFound({ message: 'Commande non trouvée.' });
      }
      return response.internalServerError({ message: 'Erreur serveur lors du reroutage.' });
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

      logger.info({ order }, 'Commande récupérée')

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
          metadata: {
            reason: metadata?.reason,
            details: metadata?.details,
            waypoint_sequence: -1,
            waypoint_status: undefined,
            waypoint_type: undefined,
          },
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
          await redis_helper.enqueuePushNotification({
            fcmToken: client.fcm_token,
            title: 'Commande annulée',
            body: 'La commande a été annulée.',
            data: { orderId: order.id, status: OrderStatus.CANCELLED, type: NotificationType.MISSION_UPDATE },
          })

        if (driver?.fcm_token)
          await redis_helper.enqueuePushNotification({
            fcmToken: driver.fcm_token,
            title: 'Commande annulée',
            body: "La commande a été annulée par l'administrateur.",
            data: { orderId: order.id, status: OrderStatus.CANCELLED, type: NotificationType.MISSION_UPDATE },
          })
      }

      await trx.commit() // Valide l'annulation

      return response.ok({ message: 'Commande annulée avec succès.' })
    } catch (error) {
      /* ... gestion erreur cancel et rollback ... */
    }
  }

  /**
  * Récupère les détails formatés d'une offre de mission pour un livreur.
  */
  async get_offer_details({ params, auth, response }: HttpContext) {
    try {
      const orderId = params.order_id || '1'
      const user = auth.user // Supposant que votre middleware 'auth' attache l'utilisateur (driver) à `auth.user`

      if (!user) {
        return response.unauthorized({ message: 'Authentification requise.' })
      }

      const driver = await Driver.query()
        .where('user_id', user.id)
        .first()

      if (!driver) {
        return response.unauthorized({ message: 'Authentification requise.' })
      }
      // Charger la commande avec les relations nécessaires
      let order = await Order.query()
        .where('id', orderId)
        .preload('route_legs')
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc'))
        .first()



      if (!order) {
        const orderOffered = await Order.query()
          .where('offered_driver_id', driver.id)
          // .where('offer_expires_at', '>', DateTime.now().toSQLDate())
          .preload('route_legs') // Pour obtenir les géométries des legs
          .preload('status_logs', (q) => q.orderBy('changed_at', 'desc'))
          .first()
        if (!orderOffered) {
          let driverStatus = await DriversStatus.query()
            .where('driver_id', driver.id)
            .orderBy('changed_at', 'desc')


          if (driverStatus?.[0].status === DriverStatus.OFFERING) {
            await DriversStatus.create({
              id: cuid(),
              driver_id: driver.id,
              status: driverStatus?.[1].status,
              changed_at: DateTime.now(),
              assignments_in_progress_count: driverStatus?.[1].assignments_in_progress_count,
              metadata: { reason: `offer_ended_for_order` },
            })
            if (driver.fcm_token)
              redis_helper.enqueuePushNotification({
                fcmToken: driver.fcm_token,
                title: 'Mise à jour de votre disponibilité',
                body: `Votre statut de disponibilité est remis à : ${driverStatus?.[1].status}.`,
                data: { newStatus: driverStatus?.[1].status, type: NotificationType.SCHEDULE_REMINDER, timestamp: DateTime.now().toISO() },
              })
          }
          return response.ok({ message: 'Offre de mission non trouvée.' })
        }
        order = orderOffered
      }

      // Vérifier si l'offre est bien pour ce livreur et n'est pas expirée
      // (et que la commande est dans un statut où elle peut être offerte, ex: PENDING)
      if (order.offered_driver_id !== driver.id) {
        return response.forbidden({ message: "Cette offre ne vous est pas destinée." })
      }
      if (order.offer_expires_at && order.offer_expires_at < DateTime.now()) {
        return response.gone({ message: "Cette offre a expiré." })
      }
      if (order.status_logs[0].status !== OrderStatus.PENDING) {
        return response.forbidden({ message: "Cette commande n'est plus en statut PENDING." })
      }


      // Construire la réponse EnrichedMissionOffer
      if (!order.waypoints_summary) {
        // Cas critique : une offre ne devrait pas exister sans waypoints_summary
        console.error(`Order ${order.id} is offered but has no waypoints_summary.`);
        return response.internalServerError({ message: "Données de mission incomplètes pour cette offre." });
      }

      // Calculer la distance et la durée totales à partir des legs si elles ne sont pas stockées sur l'Order
      // (Idéalement, ces valeurs seraient calculées et stockées sur l'Order lors de sa création/optimisation)
      let estimatedTotalDistanceMeters = 0;
      let estimatedTotalDurationSeconds = 0;

      if (order.route_legs && order.route_legs.length > 0) {
        for (const leg of order.route_legs) {
          estimatedTotalDistanceMeters += leg.distance_meters || 0;
          estimatedTotalDurationSeconds += leg.duration_seconds || 0;
        }
      } else {
        // Fallback si pas de legs, essayer de sommer les estimations sur l'order si elles existent
        // Cette logique dépend de comment vous stockez ces totaux
        // Par exemple, si order.route_distance_meters et order.route_duration_seconds existent
        // estimatedTotalDistanceMeters = order.route_distance_meters || 0;
        // estimatedTotalDurationSeconds = order.route_duration_seconds || 0;
        console.warn(`Order ${order.id} has no route_legs, total distance/duration might be inaccurate for offer.`);
      }


      const enrichedOffer = {
        orderId: order.id,
        estimatedRemuneration: order.remuneration, // Assurez-vous que c'est bien la rémunération du livreur
        currency: order.currency,
        estimatedTotalDistanceMeters: estimatedTotalDistanceMeters,
        estimatedTotalDurationSeconds: estimatedTotalDurationSeconds,
        waypointsSummary: order.waypoints_summary.map(wp => ({
          type: wp.type,
          address_text: wp.address_text || 'Adresse non spécifiée', // Utiliser address_text directement
          sequence: wp.sequence,
          name: wp.name, // Sera undefined si non présent
          coordinates: wp.coordinates, // Doit être [lon, lat]
        })),
        // Extraire uniquement les géométries des legs de route
        routeLegsGeometry: order.route_legs?.map(leg => ({
          // La géométrie du leg est un objet GeoJSON LineString, on veut juste les coordonnées
          coordinates: leg?.geometry?.coordinates,
        })) || [], // Tableau vide si pas de legs
        expiresAt: order.offer_expires_at ? order.offer_expires_at.toISO() : DateTime.now().plus({ seconds: 30 }).toISO(), // Fallback pour expiresAt
        priority: order.priority,
        noteOrder: order.note_order,
      };

      return response.ok(enrichedOffer);

    } catch (error) {
      console.error('Error in getOfferDetails:', error);
      return response.internalServerError({ message: 'Erreur serveur lors de la récupération des détails de l’offre.' });
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
            .preload('changed_by_user', (u) => u.select(['id', 'full_name']))
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
              const routeToDelivery = await geo_helper.calculateOptimizedRoute(
                [{ coordinates: [order.driver.current_location.coordinates[0], order.driver.current_location.coordinates[1]], type: 'through' },
                { coordinates: [order.delivery_address.coordinates.coordinates[0], order.delivery_address.coordinates.coordinates[1]], type: 'through' }]
              )
              if (routeToDelivery) {
                estimatedTimeToArrivalSeconds = routeToDelivery.global_summary.total_duration_seconds
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

      const hasSuitableVehicle = driver.vehicles.length > 0
      // &&
      // driver.vehicles.some(
      //   (vehicle) => vehicle.max_weight_kg === null || vehicle.max_weight_kg >= totalWeightG // Poids OK
      // )

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
      // order.driver_id = driver_id
      const offerExpiresAt = DateTime.now().plus({ seconds: OFFER_DURATION_SECONDS })

      order.offered_driver_id = driver_id
      order.offer_expires_at = offerExpiresAt

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
        const notifData = { type: NotificationType.NEW_MISSION_OFFER, order_id: orderId }
        await redis_helper.enqueuePushNotification({
          fcmToken: driver.fcm_token,
          title: notifTitle,
          body: notifBody,
          data: notifData,
        })
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
          status: OrderStatus.PENDING, // Statut devient ACCEPTED
          changed_at: DateTime.now(),
          changed_by_user_id: adminUser.id, // L'admin initie ce statut
          metadata: { reason: 'assigned_by_admin', waypoint_sequence: -1, waypoint_status: undefined, waypoint_type: undefined, }, // Metadata indiquant l'origine
          current_location: logLocation,
        },
        { client: trx }
      )
      logger.info(
        `OrderStatusLog created with ACCEPTED status for Order ${orderId} by Admin ${adminUser.id}.`
      )
      //Mettre à jour Statut Driver -> PENDING
      await DriversStatus.create(
        {
          id: cuid(),
          driver_id,
          status: DriverStatus.OFFERING,
          changed_at: DateTime.now(),
        },
        { client: trx }
      )
      logger.info(
        `Driver ${driver_id} status set to PENDING for manual assignment of Order ${orderId}`
      )
      await order.useTransaction(trx).save() // Sauvegarde le driver_id via trx
      // 10. Commit Transaction
      await trx.commit()

      try {
        await redis_helper.publishMissionManuallyAssigned(
          orderId,
          driver_id, // Le chauffeur assigné
          adminUser.id // L'ID de l'admin qui a fait l'assignation
        )
        logger.info(`Event MANUALLY_ASSIGNED published for Order ${orderId}, Driver ${driver_id}.`)
      } catch (eventError) {
        logger.error({ err: eventError, orderId, driverId: driver_id }, "Failed to publish MANUALLY_ASSIGNED event after admin assignment.");
        // L'assignation a réussi, mais l'événement n'a pas été publié.
        // C'est une situation à surveiller, mais l'état principal (assignation) est correct.
      }


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
          .preload('changed_by_user', (u) => u.select(['id', 'full_name']))
      ) // Récent historique
      await order.load('pickup_address')
      await order.load('delivery_address')
      await order.load('packages')
      await order.load('route_legs')

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
      return response.internalServerError({ message: "Erreur serveur lors de l'assignation.", error })
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
            waypoint_sequence: -1,
            waypoint_status: undefined,
            waypoint_type: undefined,
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
              await redis_helper.enqueuePushNotification({
                fcmToken: order.driver.fcm_token,
                title: 'Mission Annulée (Admin)',
                body: `La course #${orderId.substring(0, 6)}... a été annulée par un administrateur. Raison: ${reason_code}. Arrêtez votre progression.`,
                data: { orderId: orderId, status: OrderStatus.CANCELLED, reason: reason_code, type: NotificationType.MISSION_UPDATE },
              })
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

      try {
        // L'ID du chauffeur assigné (s'il y en avait un) est dans order.driver_id
        // que nous avons chargé (ou il est null).
        await redis_helper.publishMissionCancelledByAdmin(
          orderId,
          reason_code, // La raison de l'annulation
          order.driver_id! // Peut être null si la commande n'était pas encore assignée
        )
        logger.info(`Event CANCELLED_BY_ADMIN published for Order ${orderId}.`)
      } catch (eventError) {
        logger.error({ err: eventError, orderId }, "Failed to publish CANCELLED_BY_ADMIN event after admin cancellation.");
        // L'annulation a réussi, mais l'événement n'a pas été publié.
        // C'est une situation à surveiller.
      }


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
  } // Fin admin_cancel_order //Un service de remboursement client pourrait écouter
  //  cet événement pour initier un remboursement si la commande était prépayée.

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
            waypoint_sequence: -1,
            waypoint_status: undefined,
            waypoint_type: undefined,
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
              await redis_helper.enqueuePushNotification({
                fcmToken: order.driver.fcm_token,
                title: 'Mission Réussie (Admin)',
                body: `La course #${orderId.substring(0, 6)}... a été marquée comme réussie. Raison: ${success_reason_code}${reason_details ? ` (${reason_details})` : ''}.`,
                data: { orderId, status: OrderStatus.SUCCESS, reason: success_reason_code, type: NotificationType.MISSION_UPDATE },
              })
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
      if (assignedDriverId) { // assignedDriverId a été défini plus haut (order.driver_id)
        try {
          // Utiliser la rémunération finale de la commande.
          // Si la rémunération peut être ajustée par l'admin lors de cette action,
          // il faudrait la récupérer du payload et la passer ici.
          // Pour l'instant, on utilise order.remuneration.
          await redis_helper.publishMissionCompleted(
            orderId,
            assignedDriverId,
            order.remuneration // ou une `finalRemuneration` si l'admin peut l'ajuster
          )
          logger.info(`Event COMPLETED published for Order ${orderId}, Driver ${assignedDriverId} for payment and other processes.`)
        } catch (eventError) {
          logger.error(
            { err: eventError, orderId, driverId: assignedDriverId },
            "Failed to publish COMPLETED event after admin marked order as success."
          );
          // La commande est marquée comme SUCCESS, mais le processus de paiement n'a pas été
          // automatiquement déclenché via l'événement. Nécessitera une intervention manuelle
          // ou un autre mécanisme pour s'assurer que le chauffeur est payé.
        }
      } else {
        // Si aucun chauffeur n'était assigné mais la mission est marquée SUCCESS (cas étrange, mais possible)
        // il n'y a pas de paiement de chauffeur à déclencher via cet événement.
        // D'autres logiques (notification client, etc.) pourraient toujours être pertinentes
        // si un autre service écoute aussi les `COMPLETED` sans `driverId`.
        // Pour l'instant, on ne publie pas si pas de driverId.
        logger.info(`Order ${orderId} marked SUCCESS by admin, but no driver was assigned. No COMPLETED event published for driver payment.`);
      }
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
            waypoint_sequence: -1,
            waypoint_status: undefined,
            waypoint_type: undefined,
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
              await redis_helper.enqueuePushNotification({
                fcmToken: order.driver.fcm_token,
                title: 'Mission Échouée (Admin)',
                body: `La course #${orderId.substring(0, 6)}... a été marquée comme échouée. Raison: ${failure_reason_code}${reason_details ? ` (${reason_details})` : ''}. Aucun action supplémentaire requise.`,
                data: { orderId, status: OrderStatus.FAILED, reason: failure_reason_code, type: NotificationType.MISSION_UPDATE },
              })
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
        driver.delivery_stats = driver.delivery_stats || {}

        // Ajoute la nouvelle entrée
        driver.delivery_stats[orderId] = {
          status: 'failure',
          timestamp: DateTime.now().toISO(),
        }

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

      try {
        await redis_helper.publishMissionFailed(
          orderId,
          failure_reason_code,
          reason_details || undefined, // `details` est optionnel dans publishMissionFailed
          assignedDriverId || undefined // `assignedDriverId` peut être null
        );
        logger.info(`Event FAILED published for Order ${orderId}.`);
      } catch (eventError) {
        logger.error({ err: eventError, orderId }, "Failed to publish FAILED event after admin marked order as failed.");
        // La commande est marquée FAILED, mais l'événement n'a pas été publié.
      }
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
