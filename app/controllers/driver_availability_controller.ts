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
import db from '@adonisjs/lucid/services/db'


/**
 * Vérifie si time1 (HH:MM ou HH:MM:SS) est strictement avant time2.
 * @param time1 Chaîne de temps 1
 * @param time2 Chaîne de temps 2
 * @returns boolean
 */
const isValidTimeFormat = (time: string): boolean => /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/.test(time);

const isTimeBefore = (time1: string | null | undefined, time2: string | null | undefined): boolean => {
  // Vérifie si les formats sont valides et si les deux temps existent
  if (!time1 || !time2 || !isValidTimeFormat(time1) || !isValidTimeFormat(time2)) {
    // Si l'un des temps est invalide ou manquant, on ne peut pas comparer de manière fiable
    // On pourrait retourner false ou lancer une erreur selon la sévérité voulue.
    // Retourner false est plus prudent ici pour ne pas bloquer si une heure manque temporairement.
    console.warn(`isTimeBefore comparison skipped due to invalid/missing time(s): ${time1}, ${time2}`);
    return false; // Ou considérer comme valide? Dépend de la logique. False est plus strict.
  }
  // Utilise une date arbitraire pour comparer uniquement les heures/minutes
  // avec Luxon (plus robuste que la comparaison de chaînes)
  const dt1 = DateTime.fromFormat(time1.substring(0, 5), 'HH:mm'); // Prend seulement HH:MM
  const dt2 = DateTime.fromFormat(time2.substring(0, 5), 'HH:mm');

  // Vérifie si les objets DateTime sont valides après parsing
  if (!dt1.isValid || !dt2.isValid) {
    console.warn(`isTimeBefore comparison skipped due to invalid parsed DateTime: ${time1}, ${time2}`);
    return false; // Parsing échoué
  }

  // Compare les temps
  return dt1 < dt2;
};

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
const availabilityRulesBatchPayload = vine.compile(vine.object({
  rulesToCreate: vine.array(
    vine.object({
      // Exclure id, driver_id (sera ajouté), created/updated_at
      day_of_week: vine.number().min(0).max(6),
      start_time: availabilityTimeFormatRule,
      end_time: availabilityTimeFormatRule,
      // is_active sera toujours true pour la création depuis le frontend actuel
      // Mais on peut le laisser optionnel si l'API doit le gérer
      // is_active: vine.boolean().optional().default(true)
    })
  ).optional(), // Le tableau entier peut être optionnel

  rulesToUpdate: vine.array(
    vine.object({
      id: vine.string(), // ID de la règle à mettre à jour
      // Champs optionnels pour la mise à jour partielle (PATCH)
      day_of_week: vine.number().min(0).max(6).optional(),
      start_time: availabilityTimeFormatRule.optional(),
      end_time: availabilityTimeFormatRule.optional(),
      is_active: vine.boolean().optional(), // Peut être utilisé pour activer/désactiver
    })
  ).optional(),

  ruleIdsToDelete: vine.array(vine.string()).optional(), // Pour suppression future
})
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
    const user = await auth.authenticate()
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
    const user = await auth.authenticate()
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
    const user = await auth.authenticate()
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
    const user = await auth.authenticate()
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
    const user = await auth.authenticate()
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
    const user = await auth.authenticate()
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
    const user = await auth.authenticate()
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
    const user = await auth.authenticate()
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


  // ===============================================
  // === NOUVELLE MÉTHODE BATCH ===
  // ===============================================
  /**
   * [DRIVER] Met à jour l'ensemble des règles de disponibilité en une seule requête.
   * Gère les créations, modifications (heures, activation/désactivation) et suppressions.
   * POST /driver/availability/rules/batch (ou PATCH)
   */
  async update_rules_batch({ auth, request, response }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate()
    const driver = await Driver.findByOrFail('user_id', user.id) // Trouve ou échoue
    const driverId = driver.id

    logger.info({ driverId }, 'Attempting batch update for availability rules.');

    // 1. Valider le payload global
    let payload;
    try {
      payload = await request.validateUsing(availabilityRulesBatchPayload)
    } catch (error) {
      logger.warn({ err: error, driverId }, 'Invalid batch payload for availability rules.');
      return response.badRequest({ message: 'Données batch invalides.', errors: error.messages })
    }

    const { rulesToCreate = [], rulesToUpdate = [], ruleIdsToDelete = [] } = payload;

    // Début de la Transaction BDD
    const trx = await db.transaction()
    try {

      // --- Logique Interne de Validation & Traitement ---

      // A. Pré-validation Rapide des nouvelles règles et des màj (syntaxe temps, fin > debut)
      const allPotentialRules = [
        ...rulesToCreate.map(r => ({ ...r, is_active: true })), // Nouvelles règles sont actives
        ...rulesToUpdate.map(r => ({
          // Pour la validation, on a besoin de l'état final potentiel
          // On va chercher l'état actuel et merger, mais c'est complexe ici sans fetch
          // Simplification: on valide juste les heures fournies pour la MàJ
          id: r.id,
          day_of_week: r.day_of_week, // Garde si présent
          start_time: r.start_time,
          end_time: r.end_time,
          is_active: r.is_active // Peut être undefined
        }))
      ];

      for (const ruleData of allPotentialRules) {
        if (ruleData.start_time && ruleData.end_time && !isTimeBefore(ruleData.start_time, ruleData.end_time)) {
          await trx.rollback();
          return response.badRequest({ message: `Règle invalide : l'heure de début (${ruleData.start_time}) doit précéder l'heure de fin (${ruleData.end_time}).` });
        }
      }

      // B. Traitement des Suppressions (SI vous l'implémentez)
      if (ruleIdsToDelete.length > 0) {
        logger.debug({ driverId, ruleIdsToDelete }, 'Deleting availability rules.');
        await DriverAvailabilityRule.query({ client: trx })
          .where('driver_id', driverId)
          .whereIn('id', ruleIdsToDelete)
          .delete();
      }


      // C. Traitement des Mises à Jour (Activation/Désactivation/Changement heures)
      if (rulesToUpdate.length > 0) {
        logger.debug({ driverId, count: rulesToUpdate.length }, 'Updating availability rules.');
        // Itère sur chaque règle à mettre à jour
        for (const updateData of rulesToUpdate) {
          const { id, ...dataToMerge } = updateData;
          // Trouve la règle originale (dans la transaction) pour s'assurer qu'elle appartient bien au driver
          const rule = await DriverAvailabilityRule.query({ client: trx })
            .where('id', id)
            .andWhere('driver_id', driverId)
            .first();

          if (rule) {
            // Applique la mise à jour (peut inclure start_time, end_time, is_active)
            rule.merge(dataToMerge);
            // !! Validation de chevauchement ici lors de la MàJ !!
            // (On doit re-vérifier par rapport aux AUTRES règles finales de CE jour là)
            // C'est complexe dans un batch, idéalement le frontend pré-valide,
            // mais une sécurité ici serait bien (non implémenté pour la concision)
            await rule.save(); // Sauvegarde via la transaction
          } else {
            logger.warn({ driverId, ruleId: id }, "Rule ID provided for update not found or doesn't belong to driver.");
            // Ignorer silencieusement ou retourner une erreur ? Ignorer pour l'instant.
          }
        }
      }

      // D. Traitement des Créations
      if (rulesToCreate.length > 0) {
        logger.debug({ driverId, count: rulesToCreate.length }, 'Creating new availability rules.');
        const rulesToInsert = rulesToCreate.map(ruleData => ({
          id: cuid(), // Génère un nouvel ID
          driver_id: driverId, // Associe au driver actuel
          ...ruleData,
          is_active: true, // Force active à la création (ou utiliser valeur par défaut du modèle?)
        }));

        // !! Validation de chevauchement ici lors de la Création !!
        // Pour chaque `ruleData` dans `rulesToCreate`:
        //    1. Récupérer toutes les règles *finales* (existantes mises à jour + autres nouvelles) pour `ruleData.day_of_week`.
        //    2. Vérifier si `ruleData` chevauche une de ces règles finales.
        //    3. Si oui, rollback et erreur 400.
        // (Complexe à implémenter proprement ici sans surcharger, dépend de votre niveau d'exigence sur la validation backend)

        // Insertion en masse si possible (si pas de validation complexe nécessaire)
        await DriverAvailabilityRule.createMany(rulesToInsert, { client: trx });
      }

      // Si tout s'est bien passé
      await trx.commit() // Valide toutes les opérations atomiquement
      logger.info({ driverId }, 'Availability rules batch update committed successfully.');

      // Invalider le cache Redis APRÈS le commit réussi
      await this.invalidateAvailabilityCache(driverId)

      return response.ok({ message: 'Planning mis à jour avec succès.' }) // Ou 204 No Content

    } catch (error) {
      await trx.rollback() // Annule tout en cas d'erreur PENDANT la transaction
      logger.error({ err: error, driverId }, 'Error during availability rules batch update transaction.');
      // Si erreur spécifique (ex: contrainte unique BDD pour chevauchement), retourner 400
      // if (error.code === '...') return response.badRequest({...});
      return response.internalServerError({ message: 'Erreur serveur lors de la mise à jour du planning.' })
    }
  }

} // Fin contrôleur
