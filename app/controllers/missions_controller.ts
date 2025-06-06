import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import db from '@adonisjs/lucid/services/db'
import Order, { waypointStatus, WaypointSummaryItem } from '#models/order'
import OrderStatusLog from '#models/order_status_log'
import { OrderStatus } from '#models/order' // Tous les enums Order
import DriversStatus, { DriverStatus } from '#models/drivers_status'
import Driver from '#models/driver'
import logger from '@adonisjs/core/services/logger'
import { cuid } from '@adonisjs/core/helpers'
import { DateTime } from 'luxon'
// import { updateMissionStatusValidator } from '#validators/mission/update_mission_status_validator'

// --- Importer les Helpers ---
// import { updateFiles, deleteFiles } from '#services/file_service' // Pour les preuves
import vine from '@vinejs/vine'
import redis_helper from '#services/redis_helper'
import Client from '#models/client'
import { NotificationType } from '#models/notification'

@inject()
export default class MissionController {

  async show({ response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('driver')
    if (!user.driver) return response.forbidden({ message: 'Livreur non trouvé.' })


    try {
      const order = await Order.query()
        .where('driver_id', user.driver.id) // Le client ne voit que SES commandes
        .preload('pickup_address')
        .preload('route_legs')
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
        { err: error, driverId: user.driver.id },
        'Erreur récupération mission'
      )
      return response.internalServerError({
        message: 'Erreur serveur lors de la récupération de la mission.',
      })
    }
  }

  /**
   * [DRIVER] Accepte une mission proposée, en vérifiant l'offre active.
   * POST /missions/:orderId/accept
   */
  async accept({ params, auth, response }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate() // Driver authentifié
    // Retrouver le profil Driver pour l'ID stable (pourrait être fait différemment)
    const driver = await Driver.query().where('user_id', user.id).first() // On peut supposer qu'il existe si user.role='driver'
    if (!driver) {
      logger.error(`Inconsistency: User ${user.id} has role DRIVER but no Driver profile found.`)
      return response.internalServerError({
        message: 'Erreur interne: profil livreur introuvable.',
      })
    }
    const driverId = driver.id // ID du driver
    const orderId = params.orderId

    logger.info(`Driver ${driverId} attempt to accept Order ${orderId}`)

    const trx = await db.transaction()
    try {
      // 1. Trouver commande ET précharger/vérifier l'offre + dernier log
      // On a besoin de l'objet Order pour vérifier l'offre AVANT de continuer
      const order = await Order.query({ client: trx })
        .where('id', orderId)
        .preload('pickup_address') // Pour fallback location si besoin
        .preload('route_legs')
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1))
        .first()

      if (!order) {
        await trx.rollback()
        return response.notFound({ message: 'Commande non trouvée.' })
      }

      // --- VÉRIFICATION IDÉALE DE L'OFFRE ---
      const currentStatus = order.status_logs[0]?.status ?? null // Peut être null si aucun log? unlikely

      // A. L'état doit être PENDING
      if (currentStatus !== OrderStatus.PENDING) {
        await trx.rollback()
        logger.warn(
          `Driver ${driverId} tried to accept non-pending Order ${orderId} (Status: ${currentStatus})`
        )
        return response.badRequest({
          message: "Cette commande n'est plus en attente d'acceptation.",
        })
      }

      // B. L'offre doit être pour CE driver
      if (order.offered_driver_id !== driverId) {
        await trx.rollback()
        logger.warn(
          `Driver ${driverId} tried to accept Order ${orderId} not offered to them (Offered to: ${order.offered_driver_id}).`
        )
        // On pourrait retourner 403 Forbidden ici, ou 400 Bad Request
        return response.forbidden({ message: 'Cette offre ne vous est pas (ou plus) destinée.' })
      }

      // C. L'offre ne doit pas avoir expiré
      if (!order.offer_expires_at || DateTime.now() > order.offer_expires_at) {
        // Offre expirée -> Nettoyer l'offre et refuser
        order.offered_driver_id = null
        order.offer_expires_at = null
        await order.save() // Via trx car 'order' est déjà dans la transaction
        await trx.commit() // Valide SEULEMENT le nettoyage
        logger.info(`Offer for Order ${orderId} to Driver ${driverId} expired.`)
        // TODO: Déclencher réassignation via Worker/Batch
        return response.badRequest({ message: 'Le délai pour accepter cette offre a expiré.' })
      }
      // --- FIN VÉRIFICATION OFFRE ---

      // Vérification Race Condition (sécurité supplémentaire)
      if (order.driver_id && order.driver_id !== driverId) {
        // Quelqu'un d'autre a réussi à s'assigner ENTRE la sélection et l'acceptation ? Très peu probable avec les vérifications précédentes.
        await trx.rollback()
        logger.error(
          `Critical Race Condition? Order ${orderId} assigned to ${order.driver_id} when ${driverId} was accepting a valid offer!`
        )
        return response.conflict({
          message: 'Erreur: La commande a été assignée à un autre livreur.',
        })
      }

      // --- L'offre est VALIDE, on procède à l'assignation ---

      // 2. Assigner Driver à Order et Nettoyer les champs d'offre
      order.driver_id = driverId
      order.offered_driver_id = null
      order.offer_expires_at = null
      await order.save() // Via trx

      // 3. Créer log ACCEPTED
      // (Code inchangé pour récupérer la localisation et créer le log)
      const driverLocQuery = await Driver.query({ client: trx })
        .select('current_location')
        .where('id', driverId)
        .first()
      const driverCurrentLocation = driverLocQuery?.current_location
      const logLocation = driverCurrentLocation ??
        order.pickup_address?.coordinates ?? { type: 'Point', coordinates: [0, 0] }
      await OrderStatusLog.create(
        {
          id: cuid(),
          order_id: orderId,
          status: OrderStatus.ACCEPTED,
          changed_at: DateTime.now(),
          changed_by_user_id: driverId,
          current_location: logLocation,
          metadata: null,
        },
        { client: trx }
      )

      // 4. MAJ Statut Driver -> IN_WORK
      // (Code inchangé pour trouver dernier statut driver et créer le nouveau statut IN_WORK)
      const lastDriverStatus = await DriversStatus.query({ client: trx })
        .where('driver_id', driverId)
        .orderBy('changed_at', 'desc')
        .first()
      const currentAssignments = lastDriverStatus?.assignments_in_progress_count ?? 0
      await DriversStatus.create(
        {
          id: cuid(),
          driver_id: driverId,
          status: DriverStatus.IN_WORK,
          changed_at: DateTime.now(),
          assignments_in_progress_count: currentAssignments + 1,
          metadata: null,
        },
        { client: trx }
      )
      logger.info(`Driver ${driverId} status set to IN_WORK accepting Order ${orderId}`)

      // 5. TODO: Notifier le système (worker Redis?) de l'acceptation pour qu'il arrête toute autre offre potentielle ?
      // C'est moins critique si on assigne driver_id immédiatement, mais utile pour "nettoyer" des process workers.

      // 6. Notifier le client (gestion erreur silencieuse)
      let clientUser: Client | null = null
      try {
        // @ts-ignore
        await order.load('client', (q) => q.preload('user')) // Assure que la relation est chargée si ce n'était pas le cas
        if (order.client?.fcm_token) {
          clientUser = await Client.find(order.client.id)
          if (clientUser?.fcm_token) {
            await redis_helper.enqueuePushNotification({
              fcmToken: clientUser.fcm_token,
              title: 'Livreur Trouvé !',
              body: `Votre livreur est en route pour récupérer votre colis #${orderId.substring(0, 6)}...`,
              data: { order_id: order.id, status: OrderStatus.ACCEPTED, type: NotificationType.MISSION_UPDATE }, // Data utiles
            })
          }
        }
      } catch (notifError) {
        logger.error({ err: notifError, orderId }, 'Failed to send ACCEPTED notification to client')
      }

      // 7. Commit Transaction (inclut MàJ Order, création Log, création Statut Driver)
      if (!order.offer_expires_at || DateTime.now() > (order.offer_expires_at as DateTime)) {
        const expiredDriverIdForEvent = order.offered_driver_id; // Capturer avant de nullifier
        order.offered_driver_id = null;
        order.offer_expires_at = null;
        await order.save();
        await trx.commit();
        logger.info(`Offer for Order ${orderId} to Driver ${driverId} expired at acceptance attempt.`);

        if (expiredDriverIdForEvent) { // S'il y avait bien un offered_driver_id
          try {
            await redis_helper.publishMissionOfferExpired(orderId, expiredDriverIdForEvent);
            logger.info(`Event OFFER_EXPIRED published for Order ${orderId}, Driver ${expiredDriverIdForEvent}.`);
          } catch (eventError) {
            logger.error({ err: eventError, orderId, driverId: expiredDriverIdForEvent }, "Failed to publish OFFER_EXPIRED event.");
          }
        }
        return response.badRequest({ message: 'Le délai pour accepter cette offre a expiré.' });
      }

      // APRÈS LE COMMIT, publier l'événement pour informer AssignmentWorker et autres systèmes
      try {
        await redis_helper.publishMissionOfferAccepted(
          orderId,
          driverId // Le chauffeur qui a accepté
        );
        logger.info(`Event OFFER_ACCEPTED_BY_DRIVER published for Order ${orderId}, Driver ${driverId}.`);
      } catch (eventError) {
        logger.error({ err: eventError, orderId, driverId }, "Failed to publish OFFER_ACCEPTED_BY_DRIVER event after mission acceptance.");
        // L'acceptation a réussi et est en DB, mais l'événement n'a pas été publié.
        // AssignmentWorker pourrait ne pas être immédiatement notifié pour arrêter d'éventuelles recherches
        // ou nettoyer son état interne. Le scan d'expiration ou l'état de la commande en DB
        // devrait éventuellement le corriger, mais c'est une situation à surveiller.
      }

      // 8. Réponse OK au driver (avec Order mis à jour et relations chargées)
      await order.load('pickup_address') // Recharger ici si besoin
      await order.load('delivery_address')
      await order.load('packages')

      return response.ok({
        message: 'Mission acceptée !',
        order: order.serialize({
          // Sélection/Omission champs si besoin
        }),
      })
    } catch (error) {
      // Gérer le rollback si la transaction n'est pas déjà commitée (ex: offre expirée)
      if (!trx.isCompleted) {
        await trx.rollback()
      }
      logger.error({ err: error, driverId, orderId }, 'Erreur globale acceptation mission')

      // Retourner les erreurs spécifiques lancées par les vérifications ou 404/500
      if (error.status) {
        // Si on a défini un statut HTTP à l'erreur
        return response.status(error.status).send({ message: error.message })
      }
      if (
        error.code === 'E_ROW_NOT_FOUND' ||
        (error.message && error.message.includes('Commande non trouvée'))
      ) {
        return response.notFound({ message: 'Commande non trouvée.' })
      }
      // Cas d'une erreur DB non gérée spécifiquement
      return response.internalServerError({
        message: "Erreur serveur lors de l'acceptation de la mission.",
      })
    }
  }

  /**
   * [DRIVER] Refuse une mission proposée, en vérifiant et nettoyant l'offre active.
   * POST /missions/:orderId/refuse
   */
  async refuse({ params, auth, response }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    // Optionnel : Vérifier profil Driver pour consistance
    const driver = await Driver.query().where('user_id', user.id).first() // On peut supposer qu'il existe si user.role='driver'
    if (!driver) {
      logger.error(`Inconsistency: User ${user.id} has role DRIVER but no Driver profile found.`)
      return response.internalServerError({
        message: 'Erreur interne: profil livreur introuvable.',
      })
    }
    const driverId = driver.id
    const orderId = params.orderId

    logger.info(`Driver ${driverId} attempt to refuse Order ${orderId}`)

    try {
      // 1. Trouver la commande + dernier log (SANS transaction ici, c'est une lecture)
      // On a besoin de l'objet Order pour vérifier et nettoyer l'offre.
      const order = await Order.query()
        .where('id', orderId)
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1))
        .first()

      // Si la commande n'existe pas, l'offre ne peut pas exister.
      if (!order) {
        logger.warn(`Refusal attempt for non-existent Order ${orderId} by Driver ${driverId}`)
        return response.notFound({ message: 'Commande non trouvée.' })
      }

      // 2. Vérifier la pertinence du refus par rapport à l'offre et au statut
      const currentStatus = order.status_logs[0]?.status ?? null

      // A. La commande doit être PENDING pour être refusable
      if (currentStatus !== OrderStatus.PENDING) {
        logger.info(
          `Driver ${driverId} tried to refuse non-pending Order ${orderId} (Status: ${currentStatus}). Ignoring.`
        )
        return response.ok({ message: "Cette commande n'est plus en attente." }) // Pas une erreur
      }

      // B. L'offre doit être pour CE driver
      if (order.offered_driver_id !== driverId) {
        logger.info(
          `Driver ${driverId} tried to refuse Order ${orderId} not offered to them (Offered: ${order.offered_driver_id}). Ignoring.`
        )
        return response.ok({ message: 'Cette offre ne vous concerne pas/plus.' }) // Pas une erreur
      }

      // C. L'offre ne doit pas être expirée (un refus sur offre expirée n'a pas d'impact)
      if (!order.offer_expires_at || DateTime.now() > order.offer_expires_at) {
        // L'offre avait déjà expiré, le système de timeout/retry a dû la nettoyer.
        // On renvoie OK pour ne pas bloquer le driver, même si son action est tardive.
        logger.info(
          `Driver ${driverId} tried to refuse expired offer for Order ${orderId}. Ignoring.`
        )
        return response.ok({ message: 'Cette offre a déjà expiré.' })
      }

      // --- L'offre est VALIDE et pour ce DRIVER, il REFUSE ---

      // 3. Nettoyer l'offre sur l'Order
      // On le fait ici, car le refus est confirmé. Utilisation d'une transaction courte juste pour cette MaJ.
      const trx = await db.transaction()
      try {
        order.useTransaction(trx) // Applique la transaction à l'objet chargé
        order.offered_driver_id = null
        order.offer_expires_at = null
        await order.save()
        await trx.commit() // Commit juste le nettoyage de l'offre
        logger.info(`Driver ${driverId} refused Order ${orderId}. Offer fields cleared.`)
      } catch (clearError) {
        await trx.rollback() // Rollback si erreur lors du nettoyage
        logger.error(
          { err: clearError, orderId, driverId },
          'Failed to clear offer fields after refusal.'
        )
        // On continue quand même pour la réponse au driver, mais le système est dans un état potentiellement incohérent.
        // L'expiration gérera normalement ce cas.
      }

      // 4. --- Notifier le système (Worker/Batch) qu'une réassignation est nécessaire ---
      // C'est le point CRUCIAL pour relancer la recherche.
      let refusalEventPublished = false;
      try {
        const messageId = await redis_helper.publishMissionOfferRefused(orderId, driverId /*, optional_reason_from_driver */);
        if (messageId) {
          refusalEventPublished = true;
          logger.info(`Event OFFER_REFUSED_BY_DRIVER published for Order ${orderId}, Driver ${driverId}.`);
        } else {
          logger.error({ orderId, driverId }, 'Failed to publish OFFER_REFUSED_BY_DRIVER event (RedisHelper returned null).');
        }
      } catch (publishError) {
        logger.error({ err: publishError, orderId, driverId }, 'Exception publishing OFFER_REFUSED_BY_DRIVER event.');
      }

      // Notifier le driver de son refus (après la publication de l'événement principal)
      if (driver.fcm_token) {
        try {
          await redis_helper.enqueuePushNotification({
            fcmToken: driver.fcm_token,
            title: 'Refus de mission enregistré',
            body: `Vous avez refusé la mission #${orderId.substring(0, 6)}.`,
            data: { orderId: order.id, type: NotificationType.MISSION_UPDATE }, // Type de notif spécifique
          });
        } catch (e) { logger.error({ err: e, driverId }, "Failed to enqueue refusal confirmation to driver."); }
      }

      // Notifier le client si l'événement de refus a bien été publié (impliquant que la réassignation va commencer)
      if (refusalEventPublished && order.client?.fcm_token) { // Utilise la relation client préchargée
        try {
          await redis_helper.enqueuePushNotification({
            fcmToken: order.client.fcm_token,
            title: 'Recherche de livreur en cours',
            body: `Nous recherchons un nouveau livreur pour votre commande #${orderId.substring(0, 6)}.`,
            data: { orderId: order.id, type: NotificationType.MISSION_UPDATE },
          });
        } catch (e) { logger.error({ err: e, clientId: order.client.id }, "Failed to enqueue client notification after driver refusal."); }
      }

      // Si la publication de l'événement de refus CRUCIAL a échoué, c'est une erreur serveur potentielle
      // car la réassignation automatique ne sera pas immédiatement déclenchée.
      if (!refusalEventPublished) {
        // Le nettoyage de l'offre en DB a eu lieu (ou a été tenté).
        // AssignmentWorker finira par la prendre via son scan, mais c'est moins réactif.
        return response.internalServerError({
          message: 'Votre refus a été enregistré, mais un problème est survenu lors de la relance de la recherche. Le support est informé.',
        });
      }

      // 5. Logique de stats de refus / pénalités (idéalement via un autre service/worker écoutant l'événement de refus)
      // Ex: await DriverRefusalService.processRefusal({ driverId, orderId, reason: optional_reason_from_driver });

      return response.ok({ message: 'Mission refusée. Nous recherchons un autre livreur.' });

      // 5. TODO: Mettre à jour le statut du Driver si le système d'offre le mettait en PENDING (complexe) ?
      // 6. TODO: Mettre à jour les stats de refus / Appliquer pénalité ?

      // 7. Réponse OK au driver
    } catch (error) {
      logger.error({ err: error, driverId, orderId }, 'Erreur globale lors du refus de mission')
      if (error.code === 'E_ROW_NOT_FOUND') {
        return response.notFound({ message: 'Commande non trouvée.' }) // Si find échoue initialement
      }
      return response.internalServerError({
        message: 'Erreur serveur lors du refus de la mission.',
      })
    }
  }

  /**
   * [DRIVER] Met à jour le statut d'une mission en cours d'exécution.
   * Gère AT_PICKUP, EN_ROUTE, AT_DELIVERY, SUCCESS, FAILED.
   * Gère les preuves et codes de confirmation.
   * PATCH /missions/:orderId/status
   * Nécessite: Auth, Rôle Driver
   */
  // async update_mission_status({ params, request, auth, response }: HttpContext) {
  //   await auth.check()
  //   const user = await auth.authenticate() // Driver authentifié
  //   const driverId = user.id
  //   const orderId = params.orderId

  //   logger.info(`Driver ${driverId} attempt update status for Order ${orderId}`)

  //   const updateMissionStatusValidator = vine.compile(
  //     vine.object({
  //       status: vine.enum(OrderStatus),
  //       location: vine.object({
  //         latitude: vine.number(),
  //         longitude: vine.number(),
  //       }),
  //       reason: vine.string().optional(),
  //       confirmation_delivery_code: vine.string().optional(),
  //       confirmation_pickup_code: vine.string().optional(),
  //       cancellation_reason_code: vine.enum(CancellationReasonCode).optional(),
  //       failure_reason_code: vine.enum(FailureReasonCode).optional(),
  //       // failure_details: vine.string().optional(),
  //       _proofOfPickupNewPseudoUrls: vine.string().optional(),
  //       _proofOfDeliveryNewPseudoUrls: vine.string().optional(),
  //     })
  //   )
  //   // 1. Valider le payload (nouveau statut, localisation, preuves conditionnelles, etc.)
  //   const payload = await request.validateUsing(updateMissionStatusValidator)
  //   const newStatus = payload.status

  //   const trx = await db.transaction() // Transaction essentielle (Order, Log, DriverStatus, Fichiers)
  //   let order: Order | null = null
  //   let finalPickupProofUrls: string[] = []
  //   let finalDeliveryProofUrls: string[] = []

  //   try {
  //     // 2. Trouver la commande ET vérifier que CE driver y est assigné
  //     order = await Order.query({ client: trx })
  //       .where('id', orderId)
  //       .andWhere('driver_id', driverId) // <- Vérification d'assignation
  //       .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1)) // Dernier statut actuel
  //       .first()

  //     if (!order) {
  //       await trx.rollback()
  //       return response.notFound({ message: 'Commande non trouvée ou non assignée à vous.' })
  //     }

  //     // 3. Vérifier la validité de la transition de statut
  //     const currentStatus =
  //       order.status_logs.length > 0 ? order.status_logs[0].status : OrderStatus.PENDING // Sécurité
  //     const allowedTransitions: Partial<Record<OrderStatus, OrderStatus[]>> = {
  //       [OrderStatus.ACCEPTED]: [OrderStatus.AT_PICKUP],
  //       [OrderStatus.AT_PICKUP]: [OrderStatus.EN_ROUTE_TO_DELIVERY],
  //       [OrderStatus.EN_ROUTE_TO_DELIVERY]: [OrderStatus.AT_DELIVERY_LOCATION, OrderStatus.FAILED], // Peut échouer en route
  //       [OrderStatus.AT_DELIVERY_LOCATION]: [OrderStatus.SUCCESS, OrderStatus.FAILED],
  //     }

  //     if (!allowedTransitions[currentStatus]?.includes(newStatus)) {
  //       await trx.rollback()
  //       logger.warn(
  //         `Invalid status transition from ${currentStatus} to ${newStatus} for Order ${orderId} by Driver ${driverId}`
  //       )
  //       return response.badRequest({
  //         message: `Transition de statut invalide de "${currentStatus}" vers "${newStatus}".`,
  //       })
  //     }

  //     // 4. --- Logique spécifique par nouveau statut ---
  //     const statusMetadata: StatusMetadata = {
  //       reason: payload.reason || 'RAS',
  //     } // Préparer le metadata pour le log
  //     const currentLocation = {
  //       // Format pour DB
  //       type: 'Point' as const,
  //       coordinates: [payload.location.longitude, payload.location.latitude],
  //     }

  //     // == Gestion EN_ROUTE_TO_DELIVERY (inclut preuve pickup) ==
  //     if (newStatus === OrderStatus.EN_ROUTE_TO_DELIVERY) {
  //       finalPickupProofUrls = await updateFiles({
  //         request: request,
  //         table_id: orderId, // Lier à l'ID de la commande
  //         table_name: Order.table, // ou 'orders' ?
  //         column_name: 'proof_of_pickup_media',
  //         lastUrls: order.proof_of_pickup_media || [],
  //         newPseudoUrls: payload._proofOfPickupNewPseudoUrls,
  //         options: { maxSize: 10 * 1024 * 1024 },
  //         // IMPORTANT: S'assurer que `updateFiles` s'exécute dans la transaction ? Ou commit après.
  //         // Pour l'instant, on suppose qu'il ne fait pas de commit interne.
  //       })
  //       order.proof_of_pickup_media = finalPickupProofUrls // Met à jour sur la commande
  //     }

  //     // == Gestion SUCCESS (inclut preuve livraison et code) ==
  //     if (newStatus === OrderStatus.SUCCESS) {
  //       // A. Vérifier le code de confirmation
  //       if (!order.confirmation_delivery_code || order.confirmation_delivery_code !== payload.confirmation_delivery_code) {
  //         await trx.rollback()
  //         // Il se peut que le code ne soit généré qu'au moment du pickup, récupère le vrai order
  //         const realOrderCode = await Order.find(orderId, { client: trx })
  //         if (!realOrderCode || realOrderCode.confirmation_delivery_code !== payload.confirmation_delivery_code) {
  //           logger.warn(`Invalid confirmation code provided for Order ${orderId}`)
  //           return response.badRequest({ message: 'Code de confirmation invalide.' })
  //         }
  //       }

  //       // B. Gérer les preuves de livraison
  //       finalDeliveryProofUrls = await updateFiles({
  //         request: request,
  //         table_id: orderId,
  //         table_name: Order.table,
  //         column_name: 'proof_of_delivery_media',
  //         lastUrls: order.proof_of_delivery_media || [],
  //         newPseudoUrls: payload._proofOfDeliveryNewPseudoUrls,
  //         options: { maxSize: 10 * 1024 * 1024 },
  //       })
  //       order.proof_of_delivery_media = finalDeliveryProofUrls
  //     }

  //     // == Gestion FAILED ==
  //     if (newStatus === OrderStatus.FAILED) {
  //       order.failure_reason_code = payload.failure_reason_code || null
  //       order.cancellation_reason_code = payload.cancellation_reason_code || null
  //       statusMetadata.reason = payload.failure_reason_code || '' // Log dans metadata
  //       // Mettre à jour le compteur Driver aussi (voir étape 6)
  //     }

  //     // 5. Mettre à jour l'Order (preuve et code raison) et créer le log de statut
  //     // Le save de l'order est implicitement dans la transaction car chargé avec trx
  //     await order.save() // Sauve les preuves/raison si modifiées

  //     await OrderStatusLog.create(
  //       {
  //         id: cuid(),
  //         order_id: orderId,
  //         status: newStatus,
  //         changed_at: DateTime.now(),
  //         changed_by_user_id: driverId,
  //         current_location: currentLocation,
  //         metadata: Object.keys(statusMetadata).length > 0 ? statusMetadata : null,
  //       },
  //       { client: trx }
  //     )

  //     // 6. Mettre à jour le statut/compteur du driver si la mission se termine (SUCCESS ou FAILED)
  //     if ([OrderStatus.SUCCESS, OrderStatus.FAILED].includes(newStatus)) {
  //       const lastDriverStatus = await DriversStatus.query({ client: trx })
  //         .where('driver_id', driverId)
  //         .orderBy('changed_at', 'desc')
  //         .first()

  //       if (lastDriverStatus && lastDriverStatus.status === DriverStatus.IN_WORK) {
  //         const newAssignmentCount = Math.max(
  //           0,
  //           (lastDriverStatus.assignments_in_progress_count || 1) - 1
  //         )
  //         let nextDriverStatus =
  //           newAssignmentCount === 0 ? DriverStatus.ACTIVE : DriverStatus.IN_WORK

  //         // --- VÉRIFICATION PLANNING ICI ---
  //         if (newAssignmentCount === 0) {
  //           // C'était sa dernière mission
  //           // Vérifie s'il DOIT être actif selon son planning MAINTENANT
  //           const isAvailableNow = await driver_availability_checker.isAvailableBySchedule(
  //             driverId,
  //             DateTime.now()
  //           )
  //           nextDriverStatus = isAvailableNow ? DriverStatus.ACTIVE : DriverStatus.INACTIVE
  //           logger.info(
  //             `Driver ${driverId} finished last assignment. Schedule available: ${isAvailableNow}. Setting status to ${nextDriverStatus}`
  //           )
  //         } else {
  //           // Il a encore d'autres missions, il reste IN_WORK
  //           nextDriverStatus = DriverStatus.IN_WORK
  //           logger.info(
  //             `Driver ${driverId} has ${newAssignmentCount} more assignment(s). Staying IN_WORK.`
  //           )
  //         }

  //         await DriversStatus.create(
  //           {
  //             id: cuid(),
  //             driver_id: driverId,
  //             status: nextDriverStatus,
  //             changed_at: DateTime.now(),
  //             assignments_in_progress_count: newAssignmentCount,
  //           },
  //           { client: trx }
  //         )
  //         logger.info(
  //           `Driver ${driverId} status set to ${nextDriverStatus} after order ${orderId} completion/failure.`
  //         )
  //       }
  //       // TODO: Si SUCCESS, déclencher le processus de paiement du driver ? (via event Redis?)
  //       if (newStatus === OrderStatus.SUCCESS) {
  //         // Créer un log de statut pour le succès
  //         OrderStatusLog.create(
  //           {
  //             id: cuid(),
  //             order_id: orderId,
  //             status: newStatus,
  //             changed_at: DateTime.now(),
  //             changed_by_user_id: driverId,
  //             current_location: currentLocation,
  //             metadata: Object.keys(statusMetadata).length > 0 ? statusMetadata : null,
  //           },
  //           { client: trx }
  //         )
  //         //   await redis_helper.publishMissionCompleted(orderId, driverId, order.remuneration)
  //       }
  //       // TODO: Si FAILED, mettre à jour stats driver (Driver.delivery_stats)
  //       if (newStatus === OrderStatus.FAILED) {
  //         // Créer un log de statut pour le succès
  //         OrderStatusLog.create(
  //           {
  //             id: cuid(),
  //             order_id: orderId,
  //             status: newStatus,
  //             changed_at: DateTime.now(),
  //             changed_by_user_id: driverId,
  //             current_location: currentLocation,
  //             metadata: Object.keys(statusMetadata).length > 0 ? statusMetadata : null,
  //           },
  //           { client: trx }
  //         )
  //         await redis_helper.publishMissionFailed(
  //           orderId,
  //           driverId,
  //           statusMetadata.reason,
  //           statusMetadata?.details || ''
  //         )
  //       }
  //     }

  //     // TODO: Optionnel - Notifier le client du nouveau statut (AT_PICKUP, SUCCESS, FAILED etc.)
  //     //@ts-ignore
  //     const clientUser = await Client.query().where('id', order.client_id).preload('user').first()
  //     let notifTitle = ''
  //     let notifBody = ''
  //     let notifData = { type: NotificationType.MISSION_UPDATE, order_id: orderId, status: newStatus, reason: statusMetadata.reason || '' }
  //     if (clientUser?.fcm_token) {
  //       // clientUser doit être chargé avant/pendant la transaction
  //       switch (newStatus) {
  //         case OrderStatus.EN_ROUTE_TO_DELIVERY:
  //           notifTitle = 'Colis Récupéré !'
  //           notifBody = `...`
  //           notifData = { order_id: orderId, status: newStatus, type: NotificationType.MISSION_UPDATE, reason: statusMetadata.reason || '' }
  //           break
  //         case OrderStatus.AT_DELIVERY_LOCATION:
  //           notifTitle = 'Votre livreur est là !'
  //           notifBody = `...`
  //           notifData = { order_id: orderId, status: newStatus, type: NotificationType.MISSION_UPDATE, reason: statusMetadata.reason || '' }
  //           break
  //         case OrderStatus.SUCCESS:
  //           notifTitle = 'Commande Livrée !'
  //           notifBody = `...`
  //           notifData = { order_id: orderId, status: newStatus, type: NotificationType.MISSION_UPDATE, reason: statusMetadata.reason || '' }
  //           break
  //         case OrderStatus.FAILED:
  //           notifTitle = 'Echec de Livraison'
  //           notifBody = `... Raison: ${statusMetadata.reason || 'inconnue'}.`
  //           notifData = {
  //             order_id: orderId,
  //             status: newStatus,
  //             reason: statusMetadata.reason,
  //             type: NotificationType.MISSION_UPDATE,
  //           }
  //           break
  //       }
  //       if (notifTitle && clientUser.fcm_token) {
  //         const token = clientUser.fcm_token
  //         try {
  //           // *** APPEL A REDIS HELPER ***
  //           redis_helper.enqueuePushNotification({
  //             fcmToken: token,
  //             title: notifTitle,
  //             body: notifBody,
  //             data: notifData,
  //           })
  //         } catch (enqueueError) {
  //           logger.error(
  //             { err: enqueueError, orderId, newStatus },
  //             'Failed to ENQUEUE status update notification'
  //           )
  //         }
  //       }
  //     }

  //     // 7. Commit la transaction
  //     await trx.commit()
  //     try {
  //       // On a besoin de l'orderId, du nouveau statut, et du userId du client
  //       if (order?.client_id && order?.id) {
  //         // Assure que clientUser est défini
  //         emitter.emit('order:status_updated', {
  //           order_id: orderId,
  //           client_id: order.client_id,
  //           new_status: newStatus, // finalStatus est SUCCESS ou FAILED ici
  //           timestamp: DateTime.now().toISO(),
  //           // logEntry: // Tu peux récupérer et passer le log créé si besoin
  //         })
  //       }
  //     } catch (emitError) {
  //       logger.error({ err: emitError, orderId }, 'Failed to emit order:status_updated event')
  //       // Erreur d'émission non critique pour la réponse API
  //     }
  //     // 8. Réponse au driver
  //     return response.ok({
  //       message: `Statut de la mission mis à jour à "${newStatus}".`,
  //       order_status: newStatus, // Retourne juste le nouveau statut
  //     })
  //     // Émettre l'événement APRES succès de la transaction DB
  //   } catch (error) {
  //     await trx.rollback() // Rollback TOUT (DB + potentiels effets non gérés par updateFiles)

  //     // Gérer la suppression des fichiers créés avant l'erreur ? Difficile sans RollbackManager.
  //     if (finalPickupProofUrls.length > 0 || finalDeliveryProofUrls.length > 0) {
  //       logger.warn(`Rollback update mission status ${orderId}. Files created might be orphaned.`, {
  //         finalPickupProofUrls,
  //         finalDeliveryProofUrls,
  //       })
  //       // On pourrait essayer de les supprimer ici, mais c'est risqué si le rollback était avant `updateFiles`.
  //     }

  //     logger.error(
  //       { err: error, driverId, orderId, statusAttempted: payload?.status },
  //       'Erreur mise à jour statut mission'
  //     )
  //     if (error.code === 'E_VALIDATION_ERROR') {
  //       return response.badRequest({
  //         message: 'Données de mise à jour invalides.',
  //         errors: error.messages,
  //       })
  //     }
  //     // Gérer explicitement les erreurs de notre logique (ex: transition invalide)
  //     if (error.status === 400) {
  //       return response.badRequest({ message: error.message })
  //     }
  //     if (error.status === 404) {
  //       return response.notFound({ message: error.message })
  //     }
  //     return response.internalServerError({
  //       message: 'Erreur lors de la mise à jour du statut de la mission.',
  //     })
  //   }
  // }
  async update_waypoint_status({ request, response, params, auth }: HttpContext) {
    logger.info(`update_waypoint_status ${JSON.stringify(request.all())}`)
    const updateWaypointStatusValidator = vine.compile(
      vine.object({
        new_status: vine.enum(waypointStatus), // Utilisez votre enum waypointStatus
        confirmation_code: vine.string().trim().optional(),
        location: vine.object({
          latitude: vine.number().min(-90).max(90),
          longitude: vine.number().min(-180).max(180),
        }),
        timestamp: vine.string().optional(),
        notes: vine.string().trim().optional(),
        message_issue: vine.string().trim().optional(),
        // Pour les photos, vous pourriez passer des IDs de médias déjà uploadés
        // ou gérer l'upload dans une autre requête/service.
        // Pour l'instant, on suppose que photo_urls sont des URL finales si fournies.
        photo_urls: vine.array(vine.string().url()).optional(),
      })
    )
    await auth.check()
    const user = await auth.authenticate() // Driver authentifié
    // Assurez-vous que l'utilisateur a un profil Driver
    const driverProfile = await Driver.findBy('user_id', user.id)
    if (!driverProfile) {
      return response.forbidden({ message: 'Profil livreur non trouvé pour cet utilisateur.' })
    }
    const driverId = driverProfile.id // Utilisez l'ID du modèle Driver

    const orderId = params.order_id
    const waypointSequence = parseInt(params.waypoint_sequence, 10)

    if (isNaN(waypointSequence) || waypointSequence < 0) {
      return response.badRequest({ message: 'Séquence de waypoint invalide.' })
    }

    let payload
    try {
      payload = await request.validateUsing(updateWaypointStatusValidator)
    } catch (validationError) {
      logger.warn({ err: validationError.messages, orderId, waypointSequence, driverId }, 'Validation updateWaypointStatus failed')
      return response.badRequest({ message: 'Données invalides.', errors: validationError.messages })
    }

    const { new_status, confirmation_code, location, notes, photo_urls }
      = payload
    const actionTimestamp = payload.timestamp ? DateTime.fromISO(payload.timestamp) : DateTime.now()
    const driverCurrentGeoLocation = { type: 'Point' as const, coordinates: [location.longitude, location.latitude] }

    const trx = await db.transaction()
    try {
      const order = await Order.query({ client: trx })
        .where('id', orderId)
        .preload('status_logs', q => q.orderBy('changed_at', 'desc')) // Pour le statut global actuel
        .preload('client') // Pour les notifications client
        // Pas besoin de précharger route_legs ici, sauf si la logique de statut en dépend
        .first()

      if (!order) {
        await trx.rollback()
        return response.notFound({ message: 'Commande non trouvée.' })
      }

      if (order.driver_id !== driverId) {
        await trx.rollback()
        return response.forbidden({ message: 'Vous n\'êtes pas assigné à cette commande.' })
      }

      // Vérifier si la commande est dans un état "actif"
      const currentOrderStatusGlobal = order.status_logs[0]?.status
      const activeOrderStatuses = [
        OrderStatus.ACCEPTED,
        OrderStatus.AT_PICKUP,
        OrderStatus.EN_ROUTE_TO_DELIVERY,
        OrderStatus.AT_DELIVERY_LOCATION,
      ]
      if (!currentOrderStatusGlobal || !activeOrderStatuses.includes(currentOrderStatusGlobal)) {
        await trx.rollback()
        return response.badRequest({ message: `La commande n'est pas dans un état actif pour cette action (statut actuel: ${currentOrderStatusGlobal}).` })
      }

      if (!order.waypoints_summary || waypointSequence >= order.waypoints_summary.length) {
        await trx.rollback()
        return response.badRequest({ message: `Waypoint avec la séquence ${waypointSequence} non trouvé.` })
      }

      // Clonage pour modification car le champ JSON est traité comme immuable par Lucid pour la détection de changement
      const waypointsSummaryCopy: WaypointSummaryItem[] = JSON.parse(JSON.stringify(order.waypoints_summary))
      const targetWaypoint = waypointsSummaryCopy[waypointSequence]

      if (!targetWaypoint) { // Double vérification
        await trx.rollback()
        return response.badRequest({ message: `Erreur interne: Waypoint avec la séquence ${waypointSequence} introuvable après copie.` })
      }

      // Logique de transition de statut pour le waypoint
      // Exemple: un waypoint ne peut pas passer de 'pending' à 'completed' directement sans 'arrived'
      // Ou ne peut pas être marqué 'arrived' s'il est déjà 'completed'.
      // Pour l'instant, on garde simple, mais c'est un point d'amélioration.
      if (targetWaypoint.status === waypointStatus.COMPLETED || targetWaypoint.status === waypointStatus.SKIPPED || targetWaypoint.status === waypointStatus.FAILED) {
        await trx.rollback();
        return response.badRequest({ message: `Le waypoint ${waypointSequence} est déjà finalisé (${targetWaypoint.status}).` });
      }


      // --- Mise à jour du Waypoint ---
      // const oldWaypointStatus = targetWaypoint.status
      targetWaypoint.status = new_status
      if (notes) targetWaypoint.notes = notes
      if (photo_urls) targetWaypoint.photo_urls = photo_urls // Remplacer ou ajouter ? Pour l'instant, remplacer.

      if (new_status === waypointStatus.ARRIVED) {
        targetWaypoint.start_at = actionTimestamp // Heure d'arrivée au waypoint
      } else if (new_status === waypointStatus.COMPLETED) {
        // Vérification du code de confirmation
        if (!targetWaypoint.confirmation_code) {
          await trx.rollback()
          logger.warn({ orderId, waypointSequence }, `Tentative de compléter waypoint sans code de confirmation défini.`)
          return response.badRequest({ message: 'Aucun code de confirmation n\'est configuré pour ce waypoint.' })
        }
        if (targetWaypoint.confirmation_code !== confirmation_code) {
          await trx.rollback()
          logger.warn({ orderId, waypointSequence, providedCode: confirmation_code, expectedCode: targetWaypoint.confirmation_code }, `Code de confirmation invalide pour waypoint.`)
          return response.badRequest({ message: 'Code de confirmation invalide.' })
        }
        targetWaypoint.end_at = actionTimestamp // Heure de complétion du waypoint
      }
      // Gérer 'skipped' ou 'failed' pour un waypoint si besoin (payload différent)

      order.waypoints_summary = waypointsSummaryCopy // Réassigner le tableau modifié
      // Le save de 'order' mettra à jour le champ JSON 'waypoints_summary'


      order.waypoints_summary = waypointsSummaryCopy;

      // --- Détermination du nouveau statut global de la Commande ---
      let newGlobalOrderStatus: OrderStatus | null = null;
      const allWaypoints = order.waypoints_summary;

      const finalizedWaypointStatuses: waypointStatus[] = [
        waypointStatus.COMPLETED,
        waypointStatus.SKIPPED,
        waypointStatus.FAILED,
      ];

      const nextActiveWaypointIndex = allWaypoints.findIndex(
        (wp) => !(wp.status && finalizedWaypointStatuses.includes(wp.status)) // Trouve le premier non finalisé
      );

      if (new_status === waypointStatus.COMPLETED) {
        if (nextActiveWaypointIndex !== -1) {
          const veryNextActiveWaypoint = allWaypoints[nextActiveWaypointIndex];
          newGlobalOrderStatus = veryNextActiveWaypoint.type === 'pickup'
            ? OrderStatus.EN_ROUTE_TO_PICKUP
            : OrderStatus.EN_ROUTE_TO_DELIVERY;
        } else { // Tous les waypoints sont dans un état finalisé
          const mandatoryWaypoints = allWaypoints.filter(wp => wp.is_mandatory !== false); // Par défaut, is_mandatory est true
          const allMandatoryCompleted = mandatoryWaypoints.every(wp => wp.status === waypointStatus.COMPLETED);

          if (allMandatoryCompleted) {
            newGlobalOrderStatus = OrderStatus.SUCCESS;
            order.delivery_date = actionTimestamp; // Date de livraison finale
          } else {
            // Au moins un waypoint obligatoire n'est pas COMPLETED (il est SKIPPED ou FAILED)
            const hasAnyMandatoryFailed = mandatoryWaypoints.some(wp => wp.status === waypointStatus.FAILED);
            if (hasAnyMandatoryFailed) {
              newGlobalOrderStatus = OrderStatus.FAILED; // Si un obligatoire a échoué, la mission globale échoue.
            } else {
              // Aucun obligatoire n'a échoué, mais certains obligatoires ont été SKIPPED.
              // Ou il y a des optionnels non complétés (mais cela ne devrait pas affecter SUCCESS si les obligatoires le sont).
              // C'est ici que PARTIALLY_COMPLETED pourrait avoir du sens si vous voulez le distinguer.
              // Si vous n'avez pas PARTIALLY_COMPLETED, cela pourrait aussi être FAILED.
              newGlobalOrderStatus = OrderStatus.PARTIALLY_COMPLETED; // Ou OrderStatus.FAILED
              // Vous pourriez vouloir enregistrer une failure_reason_code globale ici.
            }
          }
        }
      } else if (new_status === waypointStatus.ARRIVED) {
        newGlobalOrderStatus = targetWaypoint.type === 'pickup'
          ? OrderStatus.AT_PICKUP
          : OrderStatus.AT_DELIVERY_LOCATION;
      } else if (new_status === waypointStatus.SKIPPED || new_status === waypointStatus.FAILED) {
        // Le waypoint actuel a été marqué SKIPPED ou FAILED par le livreur
        // (Cela nécessiterait une action et un payload différents du client pour spécifier la raison du skip/fail)

        // Mettre à jour la raison d'échec sur le waypoint lui-même si applicable
        if (new_status === waypointStatus.FAILED && payload.message_issue) { // Supposons un champ dans le payload
          targetWaypoint.message_issue = payload.message_issue;
        }
        if (new_status === waypointStatus.SKIPPED && payload.message_issue) {
          targetWaypoint.message_issue = payload.message_issue;
        }


        if (nextActiveWaypointIndex !== -1) { // Il y a d'autres waypoints à tenter
          const veryNextActiveWaypoint = allWaypoints[nextActiveWaypointIndex];
          newGlobalOrderStatus = veryNextActiveWaypoint.type === 'pickup'
            ? OrderStatus.EN_ROUTE_TO_PICKUP
            : OrderStatus.EN_ROUTE_TO_DELIVERY;
        } else { // C'était le dernier waypoint actif potentiel
          // La logique est similaire à celle de COMPLETED, mais le résultat sera FAILED ou PARTIALLY_COMPLETED
          const mandatoryWaypoints = allWaypoints.filter(wp => wp.is_mandatory !== false);
          const allMandatoryActuallyCompleted = mandatoryWaypoints.every(wp => wp.status === waypointStatus.COMPLETED);

          if (allMandatoryActuallyCompleted) {
            // Ceci est étrange : on a skip/fail le dernier actif, mais tous les obligatoires sont complétés ?
            // Cela signifie que les seuls restants étaient optionnels et ont été skip/fail.
            // Donc, la mission est un SUCCES du point de vue des obligatoires.
            newGlobalOrderStatus = OrderStatus.SUCCESS;
            order.delivery_date = actionTimestamp;
          } else {
            // Au moins un waypoint obligatoire n'est pas COMPLETED.
            // Si on a FAILED ce waypoint, la mission globale est FAILED.
            // Si on a SKIPPED un waypoint obligatoire, la mission est aussi FAILED (ou PARTIALLY_COMPLETED).
            newGlobalOrderStatus = OrderStatus.FAILED; // Ou OrderStatus.PARTIALLY_COMPLETED
            // Enregistrer la failure_reason_code globale si pas déjà fait.
            if (!order.failure_reason_code && targetWaypoint.status === waypointStatus.FAILED) {
              // order.failure_reason_code = mapWaypointFailureToOrderFailure(targetWaypoint.failure_reason);
            }
          }
        }
      }
      // else if (new_status === waypointStatus.PENDING) {
      //   // Ce cas ne devrait pas être déclenché par le livreur pour un waypoint déjà actif.
      //   // Peut-être par un admin pour "réinitialiser" un waypoint.
      // }

      // Sauvegarder la commande avec waypoints_summary et potentiellement delivery_date mis à jour
      await order.useTransaction(trx).save()

      // Créer un OrderStatusLog si le statut global a changé
      let mainNotificationTitle = '';
      let mainNotificationBody = '';

      if (newGlobalOrderStatus && newGlobalOrderStatus !== currentOrderStatusGlobal) {
        await OrderStatusLog.create(
          {
            id: cuid(),
            order_id: order.id,
            status: newGlobalOrderStatus,
            changed_at: actionTimestamp,
            changed_by_user_id: user.id, // ID du modèle User du driver
            current_location: driverCurrentGeoLocation,
            metadata: {
              waypoint_sequence: waypointSequence, waypoint_status: new_status, waypoint_type: targetWaypoint.type,
              ...(new_status === waypointStatus.FAILED && targetWaypoint.message_issue && { waypoint_message_issue: targetWaypoint.message_issue }),
              ...(new_status === waypointStatus.SKIPPED && targetWaypoint.message_issue && { waypoint_message_issue: targetWaypoint.message_issue }),
            },
          },
          { client: trx }
        )
        logger.info({ orderId, oldGlobalStatus: currentOrderStatusGlobal, newGlobalStatus: newGlobalOrderStatus }, `Order global status changed.`);

        // Préparer les notifications pour le client
        switch (newGlobalOrderStatus) {
          case OrderStatus.AT_PICKUP:
            mainNotificationTitle = 'Livreur à la collecte';
            mainNotificationBody = `Votre livreur est arrivé au point de collecte pour la commande #${orderId.substring(0, 6)}.`;
            break;
          case OrderStatus.EN_ROUTE_TO_DELIVERY:
            mainNotificationTitle = 'Colis récupéré';
            mainNotificationBody = `Votre colis pour la commande #${orderId.substring(0, 6)} a été récupéré et est en route.`;
            break;
          case OrderStatus.AT_DELIVERY_LOCATION:
            mainNotificationTitle = 'Livreur à destination';
            mainNotificationBody = `Votre livreur est arrivé au point de livraison pour la commande #${orderId.substring(0, 6)}.`;
            break;
          case OrderStatus.SUCCESS:
            mainNotificationTitle = 'Commande Livrée !';
            mainNotificationBody = `Votre commande #${orderId.substring(0, 6)} a été livrée avec succès. Merci !`;
            break;
          // Ajouter cas FAILED etc.
        }
      }


      // Mettre à jour le statut du driver si la mission globale est terminée (SUCCESS ou FAILED)
      if (newGlobalOrderStatus === OrderStatus.SUCCESS || newGlobalOrderStatus === OrderStatus.FAILED) {
        const lastDriverStatus = await DriversStatus.query({ client: trx })
          .where('driver_id', driverId)
          .orderBy('changed_at', 'desc')
          .first()

        if (lastDriverStatus && lastDriverStatus.status === DriverStatus.IN_WORK) {
          const newAssignmentCount = Math.max(0, (lastDriverStatus.assignments_in_progress_count || 1) - 1)
          // Logique pour vérifier la dispo par planning (si newAssignmentCount === 0)
          // const isAvailableNow = await driver_availability_checker.isAvailableBySchedule(driverId, DateTime.now());
          // const nextDriverStatus = (newAssignmentCount === 0 && isAvailableNow) ? DriverStatus.ACTIVE : (newAssignmentCount === 0 ? DriverStatus.INACTIVE : DriverStatus.IN_WORK);
          const nextDriverStatus = newAssignmentCount === 0 ? DriverStatus.ACTIVE : DriverStatus.IN_WORK; // Simplifié

          await DriversStatus.create({
            id: cuid(),
            driver_id: driverId,
            status: nextDriverStatus,
            changed_at: DateTime.now(),
            assignments_in_progress_count: newAssignmentCount,
          }, { client: trx })
          logger.info(`Driver ${driverId} status updated to ${nextDriverStatus} after order ${orderId} finalization.`);

          // TODO: Si SUCCESS, déclencher paiement (via event RedisHelper)
          // if (newGlobalOrderStatus === OrderStatus.SUCCESS) {
          //   await redis_helper.publishMissionCompleted(order.id, driverId, order.remuneration);
          // }
        }
      }


      await trx.commit()

      // Envoyer la notification au client après le commit
      if (mainNotificationTitle && order.client?.fcm_token) {
        try {
          await redis_helper.enqueuePushNotification({
            fcmToken: order.client.fcm_token,
            title: mainNotificationTitle,
            body: mainNotificationBody,
            data: { order_id: order.id, status: newGlobalOrderStatus || currentOrderStatusGlobal, type: NotificationType.MISSION_UPDATE }
          });
        } catch (notifError) {
          logger.error({ err: notifError, orderId }, 'Failed to send waypoint status update notification to client');
        }
      }


      // Recharger pour la réponse (surtout waypoints_summary et status_logs)
      // await order.load('status_logs', q => q.orderBy('changed_at', 'desc'));
      // Le champ waypoints_summary est déjà à jour sur l'instance 'order'
      await order.load(loader => {
        loader.load('pickup_address') // Adresse globale
          .load('delivery_address') // Adresse globale
          .load('packages')
          .load('route_legs', q => q.orderBy('leg_sequence', 'asc'))
      })
      return response.ok(order) // Renvoyer l'order complet mis à jour

    } catch (error) {
      if (!trx.isCompleted) {
        await trx.rollback()
      }
      logger.error({ err: error, orderId, waypointSequence, driverId, payload }, 'Erreur updateWaypointStatus')
      // Gérer les erreurs spécifiques si besoin (ex: code de confirmation)
      return response.internalServerError({ message: 'Erreur serveur lors de la mise à jour du statut du waypoint.', error: error.message })
    }
  }

}
