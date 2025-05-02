import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import db from '@adonisjs/lucid/services/db'
import Order from '#models/order'
import OrderStatusLog, { StatusMetadata } from '#models/order_status_log'
import { OrderStatus, FailureReasonCode, CancellationReasonCode } from '#models/order' // Tous les enums Order
import DriversStatus, { DriverStatus } from '#models/drivers_status'
import Driver from '#models/driver'
import logger from '@adonisjs/core/services/logger'
import { cuid } from '@adonisjs/core/helpers'
import { DateTime } from 'luxon'
// import { updateMissionStatusValidator } from '#validators/mission/update_mission_status_validator'

// --- Importer les Helpers ---
// import { updateFiles, deleteFiles } from '#services/file_service' // Pour les preuves
import vine from '@vinejs/vine'
import { updateFiles } from '#services/media/UpdateFiles'
import User from '#models/user'
import redis_helper from '#services/redis_helper'
import emitter from '@adonisjs/core/services/emitter'
import Client from '#models/client'
import driver_availability_checker from '#services/driver_availability_checker'

@inject()
export default class MissionController {
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
            await redis_helper.enqueuePushNotification(
              clientUser.fcm_token,
              'Livreur Trouvé !',
              `Votre livreur est en route pour récupérer votre colis #${orderId.substring(0, 6)}...`,
              { orderId: order.id, status: OrderStatus.ACCEPTED } // Data utiles
            )
          }
        }
      } catch (notifError) {
        logger.error({ err: notifError, orderId }, 'Failed to send ACCEPTED notification to client')
      }

      // 7. Commit Transaction (inclut MàJ Order, création Log, création Statut Driver)
      await trx.commit()

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
      try {
        const messageId = await redis_helper.publishMissionRefused(orderId, driverId)
        await redis_helper.enqueuePushNotification(
          driver.fcm_token,
          'Refus de mission',
          `Vous avez refusé la mission #${orderId.substring(0, 6)}...`,
          { orderId: order.id, status: OrderStatus.ACCEPTED } // Data utiles
        )

        //@ts-ignore
        const ClientUser = await Client.query().where('id', order.client_id).first()

        if (ClientUser && ClientUser.fcm_token) {
          await redis_helper.enqueuePushNotification(
            ClientUser.fcm_token,
            'Recherche en cours',
            `Votre mission #${orderId.substring(0, 6)}... a été refusée.`,
            { orderId: order.id, status: OrderStatus.ACCEPTED } // Data utiles
          )
        }

        if (!messageId) {
          logger.error({ orderId, driverId }, 'Failed to publish refusal event to Redis Stream')
          return response.internalServerError({
            message: 'Erreur serveur lors de la notification de la réassignation.',
          })
        }
        logger.info(
          `Simulating notification to Redis/Worker for Order ${orderId} reassignment after refusal by ${driverId}.`
        )
      } catch (publishError) {
        logger.error(
          { err: publishError, orderId, driverId },
          'Failed to publish refusal event for reassignment!'
        )
        // Que faire ? Risque que la commande reste bloquée. Ajouter à une file d'erreur ?
      }

      // 5. TODO: Mettre à jour le statut du Driver si le système d'offre le mettait en PENDING (complexe) ?
      // 6. TODO: Mettre à jour les stats de refus / Appliquer pénalité ?

      // 7. Réponse OK au driver
      return response.ok({ message: 'Mission refusée.' })
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
  async update_mission_status({ params, request, auth, response }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate() // Driver authentifié
    const driverId = user.id
    const orderId = params.orderId

    logger.info(`Driver ${driverId} attempt update status for Order ${orderId}`)

    const updateMissionStatusValidator = vine.compile(
      vine.object({
        status: vine.enum(OrderStatus),
        location: vine.object({
          latitude: vine.number(),
          longitude: vine.number(),
        }),
        reason: vine.string().optional(),
        confirmation_code: vine.string().optional(),
        cancellation_reason_code: vine.enum(CancellationReasonCode).optional(),
        failure_reason_code: vine.enum(FailureReasonCode).optional(),
        // failure_details: vine.string().optional(),
        _proofOfPickupNewPseudoUrls: vine.string().optional(),
        _proofOfDeliveryNewPseudoUrls: vine.string().optional(),
      })
    )
    // 1. Valider le payload (nouveau statut, localisation, preuves conditionnelles, etc.)
    const payload = await request.validateUsing(updateMissionStatusValidator)
    const newStatus = payload.status

    const trx = await db.transaction() // Transaction essentielle (Order, Log, DriverStatus, Fichiers)
    let order: Order | null = null
    let finalPickupProofUrls: string[] = []
    let finalDeliveryProofUrls: string[] = []

    try {
      // 2. Trouver la commande ET vérifier que CE driver y est assigné
      order = await Order.query({ client: trx })
        .where('id', orderId)
        .andWhere('driver_id', driverId) // <- Vérification d'assignation
        .preload('status_logs', (q) => q.orderBy('changed_at', 'desc').limit(1)) // Dernier statut actuel
        .first()

      if (!order) {
        await trx.rollback()
        return response.notFound({ message: 'Commande non trouvée ou non assignée à vous.' })
      }

      // 3. Vérifier la validité de la transition de statut
      const currentStatus =
        order.status_logs.length > 0 ? order.status_logs[0].status : OrderStatus.PENDING // Sécurité
      const allowedTransitions: Partial<Record<OrderStatus, OrderStatus[]>> = {
        [OrderStatus.ACCEPTED]: [OrderStatus.AT_PICKUP],
        [OrderStatus.AT_PICKUP]: [OrderStatus.EN_ROUTE_TO_DELIVERY],
        [OrderStatus.EN_ROUTE_TO_DELIVERY]: [OrderStatus.AT_DELIVERY_LOCATION, OrderStatus.FAILED], // Peut échouer en route
        [OrderStatus.AT_DELIVERY_LOCATION]: [OrderStatus.SUCCESS, OrderStatus.FAILED],
      }

      if (!allowedTransitions[currentStatus]?.includes(newStatus)) {
        await trx.rollback()
        logger.warn(
          `Invalid status transition from ${currentStatus} to ${newStatus} for Order ${orderId} by Driver ${driverId}`
        )
        return response.badRequest({
          message: `Transition de statut invalide de "${currentStatus}" vers "${newStatus}".`,
        })
      }

      // 4. --- Logique spécifique par nouveau statut ---
      const statusMetadata: StatusMetadata = {
        reason: payload.reason || 'RAS',
      } // Préparer le metadata pour le log
      const currentLocation = {
        // Format pour DB
        type: 'Point' as const,
        coordinates: [payload.location.longitude, payload.location.latitude],
      }

      // == Gestion EN_ROUTE_TO_DELIVERY (inclut preuve pickup) ==
      if (newStatus === OrderStatus.EN_ROUTE_TO_DELIVERY) {
        finalPickupProofUrls = await updateFiles({
          request: request,
          table_id: orderId, // Lier à l'ID de la commande
          table_name: Order.table, // ou 'orders' ?
          column_name: 'proof_of_pickup_media',
          lastUrls: order.proof_of_pickup_media || [],
          newPseudoUrls: payload._proofOfPickupNewPseudoUrls,
          options: { maxSize: 10 * 1024 * 1024 },
          // IMPORTANT: S'assurer que `updateFiles` s'exécute dans la transaction ? Ou commit après.
          // Pour l'instant, on suppose qu'il ne fait pas de commit interne.
        })
        order.proof_of_pickup_media = finalPickupProofUrls // Met à jour sur la commande
      }

      // == Gestion SUCCESS (inclut preuve livraison et code) ==
      if (newStatus === OrderStatus.SUCCESS) {
        // A. Vérifier le code de confirmation
        if (!order.confirmation_code || order.confirmation_code !== payload.confirmation_code) {
          await trx.rollback()
          // Il se peut que le code ne soit généré qu'au moment du pickup, récupère le vrai order
          const realOrderCode = await Order.find(orderId, { client: trx })
          if (!realOrderCode || realOrderCode.confirmation_code !== payload.confirmation_code) {
            logger.warn(`Invalid confirmation code provided for Order ${orderId}`)
            return response.badRequest({ message: 'Code de confirmation invalide.' })
          }
        }

        // B. Gérer les preuves de livraison
        finalDeliveryProofUrls = await updateFiles({
          request: request,
          table_id: orderId,
          table_name: Order.table,
          column_name: 'proof_of_delivery_media',
          lastUrls: order.proof_of_delivery_media || [],
          newPseudoUrls: payload._proofOfDeliveryNewPseudoUrls,
          options: { maxSize: 10 * 1024 * 1024 },
        })
        order.proof_of_delivery_media = finalDeliveryProofUrls
      }

      // == Gestion FAILED ==
      if (newStatus === OrderStatus.FAILED) {
        order.failure_reason_code = payload.failure_reason_code || null
        order.cancellation_reason_code = payload.cancellation_reason_code || null
        statusMetadata.reason = payload.failure_reason_code || '' // Log dans metadata
        // Mettre à jour le compteur Driver aussi (voir étape 6)
      }

      // 5. Mettre à jour l'Order (preuve et code raison) et créer le log de statut
      // Le save de l'order est implicitement dans la transaction car chargé avec trx
      await order.save() // Sauve les preuves/raison si modifiées

      await OrderStatusLog.create(
        {
          id: cuid(),
          order_id: orderId,
          status: newStatus,
          changed_at: DateTime.now(),
          changed_by_user_id: driverId,
          current_location: currentLocation,
          metadata: Object.keys(statusMetadata).length > 0 ? statusMetadata : null,
        },
        { client: trx }
      )

      // 6. Mettre à jour le statut/compteur du driver si la mission se termine (SUCCESS ou FAILED)
      if ([OrderStatus.SUCCESS, OrderStatus.FAILED].includes(newStatus)) {
        const lastDriverStatus = await DriversStatus.query({ client: trx })
          .where('driver_id', driverId)
          .orderBy('changed_at', 'desc')
          .first()

        if (lastDriverStatus && lastDriverStatus.status === DriverStatus.IN_WORK) {
          const newAssignmentCount = Math.max(
            0,
            (lastDriverStatus.assignments_in_progress_count || 1) - 1
          )
          let nextDriverStatus =
            newAssignmentCount === 0 ? DriverStatus.ACTIVE : DriverStatus.IN_WORK

          // --- VÉRIFICATION PLANNING ICI ---
          if (newAssignmentCount === 0) {
            // C'était sa dernière mission
            // Vérifie s'il DOIT être actif selon son planning MAINTENANT
            const isAvailableNow = await driver_availability_checker.isAvailableBySchedule(
              driverId,
              DateTime.now()
            )
            nextDriverStatus = isAvailableNow ? DriverStatus.ACTIVE : DriverStatus.INACTIVE
            logger.info(
              `Driver ${driverId} finished last assignment. Schedule available: ${isAvailableNow}. Setting status to ${nextDriverStatus}`
            )
          } else {
            // Il a encore d'autres missions, il reste IN_WORK
            nextDriverStatus = DriverStatus.IN_WORK
            logger.info(
              `Driver ${driverId} has ${newAssignmentCount} more assignment(s). Staying IN_WORK.`
            )
          }

          await DriversStatus.create(
            {
              id: cuid(),
              driver_id: driverId,
              status: nextDriverStatus,
              changed_at: DateTime.now(),
              assignments_in_progress_count: newAssignmentCount,
            },
            { client: trx }
          )
          logger.info(
            `Driver ${driverId} status set to ${nextDriverStatus} after order ${orderId} completion/failure.`
          )
        }
        // TODO: Si SUCCESS, déclencher le processus de paiement du driver ? (via event Redis?)
        if (newStatus === OrderStatus.SUCCESS) {
          // Créer un log de statut pour le succès
          OrderStatusLog.create(
            {
              id: cuid(),
              order_id: orderId,
              status: newStatus,
              changed_at: DateTime.now(),
              changed_by_user_id: driverId,
              current_location: currentLocation,
              metadata: Object.keys(statusMetadata).length > 0 ? statusMetadata : null,
            },
            { client: trx }
          )
          //   await redis_helper.publishMissionCompleted(orderId, driverId, order.remuneration)
        }
        // TODO: Si FAILED, mettre à jour stats driver (Driver.delivery_stats)
        if (newStatus === OrderStatus.FAILED) {
          // Créer un log de statut pour le succès
          OrderStatusLog.create(
            {
              id: cuid(),
              order_id: orderId,
              status: newStatus,
              changed_at: DateTime.now(),
              changed_by_user_id: driverId,
              current_location: currentLocation,
              metadata: Object.keys(statusMetadata).length > 0 ? statusMetadata : null,
            },
            { client: trx }
          )
          await redis_helper.publishMissionFailed(
            orderId,
            driverId,
            statusMetadata.reason,
            statusMetadata?.details || ''
          )
        }
      }

      // TODO: Optionnel - Notifier le client du nouveau statut (AT_PICKUP, SUCCESS, FAILED etc.)
      //@ts-ignore
      const clientUser = await Client.query().where('id', order.client_id).preload('user').first()
      let notifTitle = ''
      let notifBody = ''
      let notifData = {}
      if (clientUser?.fcm_token) {
        // clientUser doit être chargé avant/pendant la transaction
        switch (newStatus) {
          case OrderStatus.EN_ROUTE_TO_DELIVERY:
            notifTitle = 'Colis Récupéré !'
            notifBody = `...`
            notifData = { orderId: orderId, status: newStatus }
            break
          case OrderStatus.AT_DELIVERY_LOCATION:
            notifTitle = 'Votre livreur est là !'
            notifBody = `...`
            notifData = { orderId: orderId, status: newStatus }
            break
          case OrderStatus.SUCCESS:
            notifTitle = 'Commande Livrée !'
            notifBody = `...`
            notifData = { orderId: orderId, status: newStatus }
            break
          case OrderStatus.FAILED:
            notifTitle = 'Echec de Livraison'
            notifBody = `... Raison: ${statusMetadata.reason || 'inconnue'}.`
            notifData = {
              orderId: orderId,
              status: newStatus,
              reason: statusMetadata.reason,
            }
            break
        }
        if (notifTitle) {
          try {
            // *** APPEL A REDIS HELPER ***
            redis_helper.enqueuePushNotification(
              clientUser.fcm_token,
              notifTitle,
              notifBody,
              notifData
            )
          } catch (enqueueError) {
            logger.error(
              { err: enqueueError, orderId, newStatus },
              'Failed to ENQUEUE status update notification'
            )
          }
        }
      }

      // 7. Commit la transaction
      await trx.commit()
      try {
        // On a besoin de l'orderId, du nouveau statut, et du userId du client
        if (order?.client_id && order?.id) {
          // Assure que clientUser est défini
          emitter.emit('order:status_updated', {
            orderId: orderId,
            clientId: order.client_id,
            newStatus: newStatus, // finalStatus est SUCCESS ou FAILED ici
            timestamp: DateTime.now().toISO(),
            // logEntry: // Tu peux récupérer et passer le log créé si besoin
          })
        }
      } catch (emitError) {
        logger.error({ err: emitError, orderId }, 'Failed to emit order:status_updated event')
        // Erreur d'émission non critique pour la réponse API
      }
      // 8. Réponse au driver
      return response.ok({
        message: `Statut de la mission mis à jour à "${newStatus}".`,
        order_status: newStatus, // Retourne juste le nouveau statut
      })
      // Émettre l'événement APRES succès de la transaction DB
    } catch (error) {
      await trx.rollback() // Rollback TOUT (DB + potentiels effets non gérés par updateFiles)

      // Gérer la suppression des fichiers créés avant l'erreur ? Difficile sans RollbackManager.
      if (finalPickupProofUrls.length > 0 || finalDeliveryProofUrls.length > 0) {
        logger.warn(`Rollback update mission status ${orderId}. Files created might be orphaned.`, {
          finalPickupProofUrls,
          finalDeliveryProofUrls,
        })
        // On pourrait essayer de les supprimer ici, mais c'est risqué si le rollback était avant `updateFiles`.
      }

      logger.error(
        { err: error, driverId, orderId, statusAttempted: payload?.status },
        'Erreur mise à jour statut mission'
      )
      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({
          message: 'Données de mise à jour invalides.',
          errors: error.messages,
        })
      }
      // Gérer explicitement les erreurs de notre logique (ex: transition invalide)
      if (error.status === 400) {
        return response.badRequest({ message: error.message })
      }
      if (error.status === 404) {
        return response.notFound({ message: error.message })
      }
      return response.internalServerError({
        message: 'Erreur lors de la mise à jour du statut de la mission.',
      })
    }
  }
}
