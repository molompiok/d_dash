/* eslint-disable @typescript-eslint/naming-convention */
import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import DriverAvailabilityRule from '#models/driver_availability_rule'
import DriverAvailabilityException from '#models/driver_availability_exception'
import logger from '@adonisjs/core/services/logger'
import { cuid } from '@adonisjs/core/helpers'
import vine from '@vinejs/vine'
import { DateTime } from 'luxon'
import Driver from '#models/driver'
import redis from '@adonisjs/redis/services/main'

// Règle date et heure (adaptée du validateur UserDocument)
const dateRule = vine.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const timeFormatRule = vine
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/)
  .optional()
  .nullable() // Heure optionnelle/nullable

export const availabilityExceptionValidator = vine.compile(
  vine
    .object({
      exception_date: dateRule, // Date au format YYYY-MM-DD
      is_unavailable_all_day: vine.boolean(),
      // Les heures sont requises SEULEMENT si is_unavailable_all_day est false
      unavailable_start_time: timeFormatRule
        .optional()
        .requiredWhen('is_unavailable_all_day', '=', false),
      unavailable_end_time: timeFormatRule
        .optional()
        .requiredWhen('is_unavailable_all_day', '=', false),
      reason: vine.string().trim().minLength(3).optional().nullable(), // Raison optionnelle
    })
    .bail(false)
)

const availabilityTimeFormatRule = vine.string().regex(/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/)

export const availabilityRuleValidator = vine.compile(
  vine
    .object({
      day_of_week: vine.number().min(0).max(6), // 0=Dimanche, ..., 6=Samedi
      start_time: availabilityTimeFormatRule, // Ex: '09:00' ou '09:00:00'
      end_time: availabilityTimeFormatRule,
      is_active: vine.boolean().optional(), // Optionnel, par défaut à true si non fourni?
    })
    .bail(false) // Ne s'arrête pas à la première erreur pour afficher tous les problèmes
)

@inject()
export default class DriverAvailabilityController {
  /** Helper pour invalider le cache Redis lié à la dispo */
  private async invalidateAvailabilityCache(driverId: string) {
    const cachePrefix = `driver_availability:${driverId}:*`
    try {
      const keys = await redis.keys(cachePrefix)
      if (keys.length > 0) {
        await redis.del(keys)
        logger.info(`Invalidated ${keys.length} availability cache keys for Driver ${driverId}`)
      }
    } catch (error) {
      logger.error({ err: error, driverId }, `Failed to invalidate availability cache.`)
    }
  }
  // ===============================================
  // Gestion des Règles Récurrentes (Rules)
  // ===============================================

  /**
   * [DRIVER] Liste SES propres règles de disponibilité récurrentes.
   * GET /driver/availability/rules
   */
  async list_rules({ auth, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()
    const driver = await Driver.query().where('user_id', user.id).firstOrFail()
    if (!driver) {
      return response.notFound({ message: 'Aucune règle de disponibilité trouvée.' })
    }
    try {
      const rules = await DriverAvailabilityRule.query()
        .where('driver_id', driver.id)
        .orderBy('day_of_week', 'asc')
        .orderBy('start_time', 'asc') // Trie par jour puis par heure de début
      return response.ok(rules)
    } catch (error) {
      logger.error({ err: error, driverId: user.id }, 'Erreur liste règles disponibilité')
      return response.internalServerError({ message: 'Erreur récupération des règles.' })
    }
  }

  /**
   * [DRIVER] Ajoute une nouvelle règle de disponibilité récurrente.
   * POST /driver/availability/rules
   */
  async add_rule({ auth, request, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()
    const driver = await Driver.query().where('user_id', user.id).firstOrFail()
    if (!driver) {
      return response.notFound({ message: 'Aucune règle de disponibilité trouvée.' })
    }
    try {
      const payload = await request.validateUsing(availabilityRuleValidator)

      if (payload.start_time && payload.end_time && payload.start_time >= payload.end_time) {
        return response.badRequest({
          message: "L'heure de début doit être antérieure à l'heure de fin",
        })
      }

      // Vérification d'empiètement (overlap check) - COMPLEXE, optionnel mais recommandé
      const existingRulesForDay = await DriverAvailabilityRule.query()
        .where('driver_id', driver.id)
        .andWhere('day_of_week', payload.day_of_week)

      for (const existingRule of existingRulesForDay) {
        // Si la nouvelle règle commence avant la fin de l'ancienne ET finit après le début de l'ancienne
        if (
          payload.start_time < existingRule.end_time &&
          payload.end_time > existingRule.start_time
        ) {
          return response.badRequest({
            message: `Conflit avec une règle existante pour ce jour (${existingRule.start_time} - ${existingRule.end_time}).`,
          })
        }
      }

      const newRule = await DriverAvailabilityRule.create({
        id: cuid(),
        driver_id: driver.id,
        day_of_week: payload.day_of_week,
        start_time: payload.start_time,
        end_time: payload.end_time,
        is_active: payload.is_active ?? true, // Active par défaut si non fourni
      })

      await this.invalidateAvailabilityCache(driver.id)
      return response.created(newRule)
    } catch (error) {
      logger.error({ err: error, driverId: driver.id }, 'Erreur ajout règle disponibilité')
      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({
          message: 'Données de règle invalides.',
          errors: error.messages,
        })
      }
      return response.internalServerError({ message: "Erreur lors de l'ajout de la règle." })
    }
  }

  /**
   * [DRIVER] Met à jour une de SES règles de disponibilité.
   * PATCH /driver/availability/rules/:ruleId
   */
  async update_rule({ auth, params, request, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()
    const ruleId = params.ruleId
    const driver = await Driver.query().where('user_id', user.id).firstOrFail()
    if (!driver) {
      return response.notFound({ message: 'Aucune règle de disponibilité trouvée.' })
    }
    try {
      const payload = await request.validateUsing(availabilityRuleValidator)

      if (payload.start_time && payload.end_time && payload.start_time >= payload.end_time) {
        return response.badRequest({
          message: "L'heure de début doit être antérieure à l'heure de fin",
        })
      }

      const rule = await DriverAvailabilityRule.query()
        .where('id', ruleId)
        .andWhere('driver_id', driver.id)
        .first()

      if (!rule) {
        return response.notFound({ message: 'Règle non trouvée ou non autorisée.' })
      }
      const overlappingRule = await DriverAvailabilityRule.query()
        .where('driver_id', driver.id)
        .andWhere('day_of_week', payload.day_of_week)
        .whereNot('id', ruleId) // Exclure la règle elle-même
        .where((q) => {
          q.where('start_time', '<', payload.end_time).andWhere('end_time', '>', payload.start_time)
        })
        .first()

      if (overlappingRule) {
        return response.badRequest({
          message: 'Conflit avec une autre règle de disponibilité pour ce jour.',
        })
      }

      // Met à jour seulement les champs fournis (si c'est un PATCH)
      rule.merge({
        day_of_week: payload.day_of_week,
        start_time: payload.start_time,
        end_time: payload.end_time,
        is_active: payload.is_active, // is_active peut être passé explicitement
      })

      await rule.save()
      await this.invalidateAvailabilityCache(driver.id)
      return response.ok(rule)
    } catch (error) {
      logger.error({ err: error, driverId: driver.id, ruleId }, 'Erreur MAJ règle disponibilité')
      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({
          message: 'Données de règle invalides.',
          errors: error.messages,
        })
      }
      if (error.code === 'E_ROW_NOT_FOUND') {
        // Ou erreur générique selon Lucid
        return response.notFound({ message: 'Règle non trouvée ou non autorisée.' })
      }
      return response.internalServerError({ message: 'Erreur lors de la mise à jour de la règle.' })
    }
  }

  /**
   * [DRIVER] Supprime une de SES règles de disponibilité.
   * DELETE /driver/availability/rules/:ruleId
   */
  async delete_rule({ auth, params, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()
    const driver = await Driver.query().where('user_id', user.id).firstOrFail()
    if (!driver) {
      return response.notFound({ message: 'Aucune règle de disponibilité trouvée.' })
    }
    const ruleId = params.ruleId
    try {
      const rule = await DriverAvailabilityRule.query()
        .where('id', ruleId)
        .andWhere('driver_id', driver.id)
        .first()

      if (!rule) {
        return response.notFound({ message: 'Règle non trouvée ou non autorisée.' })
      }

      await rule.delete()
      await this.invalidateAvailabilityCache(driver.id)
      return response.noContent() // Succès sans contenu
    } catch (error) {
      logger.error(
        { err: error, driverId: driver.id, ruleId },
        'Erreur suppression règle disponibilité'
      )
      if (error.code === 'E_ROW_NOT_FOUND') {
        return response.notFound({ message: 'Règle non trouvée ou non autorisée.' })
      }
      return response.internalServerError({ message: 'Erreur lors de la suppression de la règle.' })
    }
  }

  // ===============================================
  // Gestion des Exceptions (Indisponibilités)
  // ===============================================

  /**
   * [DRIVER] Liste SES propres exceptions de disponibilité.
   * GET /driver/availability/exceptions
   */
  async list_exceptions({ auth, request, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()
    const driver = await Driver.query().where('user_id', user.id).firstOrFail()
    if (!driver) {
      return response.notFound({ message: 'Aucune exception de disponibilité trouvée.' })
    }

    const dateQueryValidator = vine.compile(
      vine.object({
        start_date: vine
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        end_date: vine
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
    )
    const { start_date, end_date } = await request.validateUsing(dateQueryValidator)
    if (start_date && end_date) {
      const start = DateTime.fromISO(start_date)
      const end = DateTime.fromISO(end_date)

      if (start > end) {
        return response.badRequest({
          message: 'La date de début doit être antérieure ou égale à la date de fin.',
        })
      }
    }

    try {
      const query = DriverAvailabilityException.query().where('driver_id', driver.id)

      if (start_date) query.where('exception_date', '>=', start_date)
      if (end_date) query.where('exception_date', '<=', end_date)

      const exceptions = await query.orderBy('exception_date', 'asc')

      return response.ok(exceptions)
    } catch (error) {
      logger.error({ err: error, driverId: driver.id }, 'Erreur liste exceptions disponibilité')
      return response.internalServerError({ message: 'Erreur récupération des exceptions.' })
    }
  }

  /**
   * [DRIVER] Ajoute une nouvelle exception (période d'indisponibilité).
   * POST /driver/availability/exceptions
   */

  async add_exception({ auth, request, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()
    const driver = await Driver.query().where('user_id', user.id).firstOrFail()
    if (!driver) {
      return response.notFound({ message: 'Aucune exception de disponibilité trouvée.' })
    }
    try {
      const payload = await request.validateUsing(availabilityExceptionValidator)

      if (
        payload.unavailable_start_time &&
        payload.unavailable_end_time &&
        payload.unavailable_start_time >= payload.unavailable_end_time
      ) {
        return response.badRequest({
          message: "L'heure de début doit être antérieure à l'heure de fin",
        })
      }

      const existingExceptions = await DriverAvailabilityException.query()
        .where('driver_id', driver.id)
        .andWhere('exception_date', payload.exception_date)

      const hasConflict = existingExceptions.some((exception) => {
        if (exception.is_unavailable_all_day || payload.is_unavailable_all_day) {
          return true // Conflit global
        }

        // Sinon : comparer les plages horaires (chevauchement)
        return (
          exception.unavailable_start_time! < payload.unavailable_end_time! &&
          exception.unavailable_end_time! > payload.unavailable_start_time!
        )
      })

      if (hasConflict) {
        return response.badRequest({
          message: 'Conflit avec une autre exception de disponibilité à cette date.',
        })
      }

      const newException = await DriverAvailabilityException.create({
        id: cuid(),
        driver_id: driver.id,
        exception_date: DateTime.fromISO(payload.exception_date),
        is_unavailable_all_day: payload.is_unavailable_all_day,
        unavailable_start_time: payload.is_unavailable_all_day
          ? null
          : payload.unavailable_start_time,
        unavailable_end_time: payload.is_unavailable_all_day ? null : payload.unavailable_end_time,
        reason: payload.reason,
      })
      await this.invalidateAvailabilityCache(driver.id)
      return response.created(newException)
    } catch (error) {
      logger.error({ err: error, driverId: driver.id }, 'Erreur ajout exception disponibilité')

      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({
          message: "Données d'exception invalides.",
          errors: error.messages,
        })
      }

      return response.internalServerError({
        message: "Erreur lors de l'ajout de l'exception.",
      })
    }
  }

  /**
   * [DRIVER] Met à jour une de SES exceptions.
   * PATCH /driver/availability/exceptions/:exceptionId
   */
  async update_exception({ auth, params, request, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()
    const driver = await Driver.query().where('user_id', user.id).firstOrFail()
    if (!driver) {
      return response.notFound({ message: 'Aucune exception de disponibilité trouvée.' })
    }
    const exceptionId = params.exceptionId

    try {
      const payload = await request.validateUsing(availabilityExceptionValidator)
      if (
        payload.unavailable_start_time &&
        payload.unavailable_end_time &&
        payload.unavailable_start_time >= payload.unavailable_end_time
      ) {
        return response.badRequest({
          message: "L'heure de début doit être antérieure à l'heure de fin",
        })
      }

      const exception = await DriverAvailabilityException.query()
        .where('id', exceptionId)
        .andWhere('driver_id', driver.id)
        .first()

      if (!exception) {
        return response.notFound({ message: 'Exception non trouvée ou non autorisée.' })
      }

      // 💥 Vérifier s’il y a un conflit avec d’autres exceptions (hors celle en cours d'édition)
      const potentialConflicts = await DriverAvailabilityException.query()
        .where('driver_id', driver.id)
        .andWhere('exception_date', payload.exception_date)
        .whereNot('id', exceptionId)
        .where((query) => {
          if (payload.is_unavailable_all_day) {
            // Toute la journée → conflit avec n'importe quelle autre exception ce jour-là
            query.whereRaw('1=1')
          } else {
            // Sinon → on vérifie s’il y a un chevauchement horaire
            query.where('is_unavailable_all_day', true).orWhere((q) => {
              q.where('unavailable_start_time', '<', payload.unavailable_end_time!).andWhere(
                'unavailable_end_time',
                '>',
                payload.unavailable_start_time!
              )
            })
          }
        })

      if (potentialConflicts.length > 0) {
        return response.badRequest({
          message: 'Conflit avec une autre exception de disponibilité à cette date.',
        })
      }

      // 🛠 Mise à jour des champs
      exception.merge({
        exception_date: DateTime.fromISO(payload.exception_date),
        is_unavailable_all_day: payload.is_unavailable_all_day,
        unavailable_start_time: payload.is_unavailable_all_day
          ? null
          : payload.unavailable_start_time,
        unavailable_end_time: payload.is_unavailable_all_day ? null : payload.unavailable_end_time,
        reason: payload.reason,
      })
      await this.invalidateAvailabilityCache(driver.id)
      await exception.save()
      return response.ok(exception)
    } catch (error) {
      logger.error(
        { err: error, driverId: driver.id, exceptionId },
        'Erreur MAJ exception disponibilité'
      )

      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({
          message: "Données d'exception invalides.",
          errors: error.messages,
        })
      }

      if (error.code === 'E_ROW_NOT_FOUND') {
        return response.notFound({ message: 'Exception non trouvée ou non autorisée.' })
      }

      return response.internalServerError({
        message: "Erreur lors de la mise à jour de l'exception.",
      })
    }
  }

  /**
   * [DRIVER] Supprime une de SES exceptions.
   * DELETE /driver/availability/exceptions/:exceptionId
   */
  async delete_exception({ auth, params, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()
    const driver = await Driver.query().where('user_id', user.id).firstOrFail()
    if (!driver) {
      return response.notFound({ message: 'Aucune exception de disponibilité trouvée.' })
    }
    const exceptionId = params.exceptionId
    try {
      const exception = await DriverAvailabilityException.query()
        .where('id', exceptionId)
        .andWhere('driver_id', driver.id)
        .first()

      if (!exception) {
        return response.notFound({ message: 'Exception non trouvée ou non autorisée.' })
      }

      await exception.delete()
      await this.invalidateAvailabilityCache(driver.id)
      return response.noContent()
    } catch (error) {
      logger.error(
        { err: error, driverId: driver.id, exceptionId },
        'Erreur suppression exception disponibilité'
      )
      if (error.code === 'E_ROW_NOT_FOUND') {
        return response.notFound({ message: 'Exception non trouvée ou non autorisée.' })
      }
      return response.internalServerError({
        message: "Erreur lors de la suppression de l'exception.",
      })
    }
  }
} // Fin contrôleur
