import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import vine from '@vinejs/vine'
import Driver from '#models/driver'
import User from '#models/user'
import Company from '#models/company'
import Order from '#models/order'
import DriversStatus, { DriverStatus } from '#models/drivers_status'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'

// Validateurs
const assignDriverToClientValidator = vine.compile(
  vine.object({
    driver_id: vine.string(),
  })
)

const updateDriverValidator = vine.compile(
  vine.object({
    is_valid_driver: vine.boolean().optional(),
  })
)

const listDriversQueryValidator = vine.compile(
  vine.object({
    status: vine.enum(DriverStatus).optional(),
    is_valid_driver: vine.boolean().optional(),
    search: vine.string().trim().optional(), // Recherche par nom, email
    page: vine.number().min(1).optional(),
    perPage: vine.number().min(1).max(100).optional(),
  })
)

@inject()
export default class AdminDriversController {
  /**
   * [ADMIN/CLIENT] Liste tous les livreurs de l'entreprise connectée
   * GET /admin/drivers
   */
  async index({ request, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('company')

    if (!user.company) {
      return response.forbidden({ message: 'Utilisateur non associé à un compte entreprise.' })
    }

    const companyId = user.company.id

    try {
      const queryParams = await request.validateUsing(listDriversQueryValidator)
      const page = queryParams.page || 1
      const perPage = queryParams.perPage || 15

      const query = Driver.query()
        .where('company_id', companyId)
        .preload('user', (userQuery) => {
          userQuery.select('id', 'full_name', 'email', 'phone', 'photo')
        })
        .preload('vehicles', (vehicleQuery) => {
          vehicleQuery.where('status', 'active').select('id', 'type', 'license_plate', 'color')
        })

      // Filtres optionnels
      if (queryParams.status) {
        query.where('latest_status', queryParams.status)
      }

      if (queryParams.is_valid_driver !== undefined) {
        query.where('is_valid_driver', queryParams.is_valid_driver)
      }

      // Recherche par nom ou email
      if (queryParams.search) {
        query.whereHas('user', (userQuery) => {
          userQuery
            .where('full_name', 'ilike', `%${queryParams.search}%`)
            .orWhere('email', 'ilike', `%${queryParams.search}%`)
        })
      }

      const driversPaginated = await query.orderBy('created_at', 'desc').paginate(page, perPage)

      return response.ok(driversPaginated.toJSON())
    } catch (error) {
      logger.error({ err: error, companyId }, 'Erreur listage livreurs admin')
      return response.internalServerError({
        message: 'Erreur serveur lors du listage des livreurs.',
      })
    }
  }

  /**
   * [ADMIN/CLIENT] Récupère les détails d'un livreur de l'entreprise
   * GET /admin/drivers/:id
   */
  async show({ params, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('company')

    if (!user.company) {
      return response.forbidden({ message: 'Utilisateur non associé à un compte entreprise.' })
    }

    const companyId = user.company.id

    try {
      const driver = await Driver.query()
        .where('id', params.id)
        .where('company_id', companyId) // Sécurité: vérifier que le driver appartient au client
        .preload('user', (userQuery) => {
          userQuery.select('id', 'full_name', 'email', 'phone', 'photo', 'created_at')
        })
        .preload('vehicles')
        .preload('user_document')
        .preload('availability_rules')
        .preload('availability_exceptions')
        .first()

      if (!driver) {
        return response.notFound({ message: 'Livreur non trouvé ou n\'appartient pas à votre entreprise.' })
      }

      // Statistiques du livreur
      const totalOrders = await Order.query()
        .where('driver_id', driver.id)
        .where('company_id', companyId)
        .count('* as total')

      const completedOrders = await Order.query()
        .where('driver_id', driver.id)
        .where('company_id', companyId)
        .where('status', 'success')
        .count('* as total')

      const stats = {
        total_orders: Number(totalOrders[0]?.$extras.total || 0),
        completed_orders: Number(completedOrders[0]?.$extras.total || 0),
        average_rating: driver.average_rating,
      }

      return response.ok({
        driver: driver.serialize(),
        stats,
      })
    } catch (error) {
      logger.error({ err: error, driverId: params.id, companyId }, 'Erreur récupération livreur admin')
      return response.internalServerError({
        message: 'Erreur serveur lors de la récupération du livreur.',
      })
    }
  }

  /**
   * [ADMIN/CLIENT] Assigne un livreur existant à l'entreprise
   * POST /admin/drivers/assign
   */
  async assign({ request, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('company')

    if (!user.company) {
      return response.forbidden({ message: 'Utilisateur non associé à un compte entreprise.' })
    }

    const companyId = user.company.id

    try {
      const { driver_id } = await request.validateUsing(assignDriverToClientValidator)

      const driver = await Driver.find(driver_id)

      if (!driver) {
        return response.notFound({ message: 'Livreur non trouvé.' })
      }

      // Vérifier que le livreur n'appartient pas déjà à une autre entreprise
      if (driver.company_id && driver.company_id !== companyId) {
        return response.forbidden({
          message: 'Ce livreur appartient déjà à une autre entreprise.',
        })
      }

      // Si le livreur appartient déjà à cette entreprise, retourner succès
      if (driver.company_id === companyId) {
        return response.ok({
          message: 'Le livreur appartient déjà à votre entreprise.',
          driver: driver.serialize(),
        })
      }

      // Assigner le livreur à l'entreprise
      driver.company_id = companyId
      await driver.save()

      await driver.load('user', (userQuery) => {
        userQuery.select('id', 'full_name', 'email', 'phone')
      })

      logger.info({ driverId: driver.id, companyId }, 'Livreur assigné à une entreprise')

      return response.ok({
        message: 'Livreur assigné avec succès à votre entreprise.',
        driver: driver.serialize(),
      })
    } catch (error) {
      logger.error({ err: error, companyId }, 'Erreur assignation livreur')
      return response.internalServerError({
        message: 'Erreur serveur lors de l\'assignation du livreur.',
      })
    }
  }

  /**
   * [ADMIN/CLIENT] Retire un livreur de l'entreprise (company_id = null)
   * DELETE /admin/drivers/:id
   */
  async destroy({ params, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('company')

    if (!user.company) {
      return response.forbidden({ message: 'Utilisateur non associé à un compte entreprise.' })
    }

    const companyId = user.company.id

    try {
      const driver = await Driver.find(params.id)

      if (!driver) {
        return response.notFound({ message: 'Livreur non trouvé.' })
      }

      // Vérifier que le livreur appartient bien à cette entreprise
      if (driver.company_id !== companyId) {
        return response.forbidden({
          message: 'Ce livreur n\'appartient pas à votre entreprise.',
        })
      }

      // Retirer le livreur (mettre company_id à null)
      driver.company_id = null
      await driver.save()

      logger.info({ driverId: driver.id, companyId }, 'Livreur retiré de l\'entreprise')

      return response.ok({
        message: 'Livreur retiré avec succès de votre entreprise.',
      })
    } catch (error) {
      logger.error({ err: error, driverId: params.id, companyId }, 'Erreur retrait livreur')
      return response.internalServerError({
        message: 'Erreur serveur lors du retrait du livreur.',
      })
    }
  }

  /**
   * [ADMIN/CLIENT] Met à jour les informations d'un livreur (ex: validation)
   * PATCH /admin/drivers/:id
   */
  async update({ params, request, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('company')

    if (!user.company) {
      return response.forbidden({ message: 'Utilisateur non associé à un compte entreprise.' })
    }

    const companyId = user.company.id

    try {
      const payload = await request.validateUsing(updateDriverValidator)

      const driver = await Driver.find(params.id)

      if (!driver) {
        return response.notFound({ message: 'Livreur non trouvé.' })
      }

      // Vérifier que le livreur appartient bien à cette entreprise
      if (driver.company_id !== companyId) {
        return response.forbidden({
          message: 'Ce livreur n\'appartient pas à votre entreprise.',
        })
      }

      // Mettre à jour les champs autorisés
      if (payload.is_valid_driver !== undefined) {
        driver.is_valid_driver = payload.is_valid_driver
      }

      await driver.save()

      await driver.load('user', (userQuery) => {
        userQuery.select('id', 'full_name', 'email')
      })

      logger.info({ driverId: driver.id, companyId, payload }, 'Livreur mis à jour par admin')

      return response.ok({
        message: 'Livreur mis à jour avec succès.',
        driver: driver.serialize(),
      })
    } catch (error) {
      logger.error({ err: error, driverId: params.id, companyId }, 'Erreur mise à jour livreur')
      return response.internalServerError({
        message: 'Erreur serveur lors de la mise à jour du livreur.',
      })
    }
  }

  /**
   * [ADMIN/CLIENT] Récupère les commandes d'un livreur
   * GET /admin/drivers/:id/orders
   */
  async getDriverOrders({ params, request, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('company')

    if (!user.company) {
      return response.forbidden({ message: 'Utilisateur non associé à un compte entreprise.' })
    }

    const companyId = user.company.id

    try {
      const driver = await Driver.find(params.id)

      if (!driver) {
        return response.notFound({ message: 'Livreur non trouvé.' })
      }

      // Vérifier que le livreur appartient bien à cette entreprise
      if (driver.company_id !== companyId) {
        return response.forbidden({
          message: 'Ce livreur n\'appartient pas à votre entreprise.',
        })
      }

      const page = request.input('page', 1)
      const perPage = request.input('perPage', 15)

      const ordersPaginated = await Order.query()
        .where('driver_id', driver.id)
        .where('company_id', companyId) // Double sécurité
        .preload('pickup_address', (q) => q.select(['city', 'street_address']))
        .preload('delivery_address', (q) => q.select(['city', 'street_address']))
        .preload('packages', (q) => q.select(['name', 'dimensions']))
        .orderBy('created_at', 'desc')
        .paginate(page, perPage)

      return response.ok(ordersPaginated.toJSON())
    } catch (error) {
      logger.error({ err: error, driverId: params.id, companyId }, 'Erreur récupération commandes livreur')
      return response.internalServerError({
        message: 'Erreur serveur lors de la récupération des commandes.',
      })
    }
  }

  /**
   * [ADMIN/CLIENT] Récupère les statistiques d'un livreur
   * GET /admin/drivers/:id/stats
   */
  async getDriverStats({ params, response, auth }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    await user.load('company')

    if (!user.company) {
      return response.forbidden({ message: 'Utilisateur non associé à un compte entreprise.' })
    }

    const companyId = user.company.id

    try {
      const driver = await Driver.find(params.id)

      if (!driver) {
        return response.notFound({ message: 'Livreur non trouvé.' })
      }

      // Vérifier que le livreur appartient bien à cette entreprise
      if (driver.company_id !== companyId) {
        return response.forbidden({
          message: 'Ce livreur n\'appartient pas à votre entreprise.',
        })
      }

      // Statistiques globales
      const totalOrders = await Order.query()
        .where('driver_id', driver.id)
        .where('company_id', companyId)
        .count('* as total')

      const completedOrders = await Order.query()
        .where('driver_id', driver.id)
        .where('company_id', companyId)
        .where('status', 'success')
        .count('* as total')

      const cancelledOrders = await Order.query()
        .where('driver_id', driver.id)
        .where('company_id', companyId)
        .where('status', 'cancelled')
        .count('* as total')

      const failedOrders = await Order.query()
        .where('driver_id', driver.id)
        .where('company_id', companyId)
        .where('status', 'failed')
        .count('* as total')

      // Commandes des 30 derniers jours
      const thirtyDaysAgo = DateTime.now().minus({ days: 30 })
      const recentOrders = await Order.query()
        .where('driver_id', driver.id)
        .where('company_id', companyId)
        .where('created_at', '>=', thirtyDaysAgo.toSQL())
        .count('* as total')

      const stats = {
        total_orders: Number(totalOrders[0]?.$extras.total || 0),
        completed_orders: Number(completedOrders[0]?.$extras.total || 0),
        cancelled_orders: Number(cancelledOrders[0]?.$extras.total || 0),
        failed_orders: Number(failedOrders[0]?.$extras.total || 0),
        recent_orders_30d: Number(recentOrders[0]?.$extras.total || 0),
        average_rating: driver.average_rating,
        current_status: driver.latest_status,
        is_valid_driver: driver.is_valid_driver,
      }

      return response.ok(stats)
    } catch (error) {
      logger.error({ err: error, driverId: params.id, companyId }, 'Erreur récupération stats livreur')
      return response.internalServerError({
        message: 'Erreur serveur lors de la récupération des statistiques.',
      })
    }
  }
}
