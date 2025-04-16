// app/services/driver_availability_checker.ts
import { DateTime } from 'luxon'
import DriverAvailabilityRule from '#models/driver_availability_rule'
import DriverAvailabilityException from '#models/driver_availability_exception'
import logger from '@adonisjs/core/services/logger'

class DriverAvailabilityChecker {
  // Seuil pour considérer une règle ou exception comme "proche" du moment actuel
  // pour vérifier (en minutes). Peut être dans config/env.
  private readonly CHECK_THRESHOLD_MINUTES = 120 // Vérifie les règles/exceptions des +/- 2h

  async isAvailableBySchedule(driverId: string, dateTimeToCheck: DateTime): Promise<boolean> {
    if (!driverId || !dateTimeToCheck || !dateTimeToCheck.isValid) {
      logger.warn('isAvailableBySchedule invalid arguments.')
      return false
    }

    // TODO: Gérer le fuseau horaire ! Supposons UTC pour les comparaisons.
    // Si les heures sont stockées en local, il faut le TZ du driver.
    const checkTimeUtc = dateTimeToCheck.toUTC()
    const checkDateIso = checkTimeUtc.toISODate()! // YYYY-MM-DD
    const checkTimeIso = checkTimeUtc.toFormat('HH:mm:ss') // HH:mm:ss
    const checkDayOfWeekIso = checkTimeUtc.weekday === 7 ? 0 : checkTimeUtc.weekday // 0=Dim...6=Sam

    logger.trace(
      `Checking sched avail for Driver ${driverId} at ${dateTimeToCheck.toISO()} [UTC Date: ${checkDateIso}, Time: ${checkTimeIso}, DoW: ${checkDayOfWeekIso}]`
    )

    try {
      // --- 1. Vérifier Exception ce jour ---
      const exception = await DriverAvailabilityException.query()
        .where('driver_id', driverId)
        .where('exception_date', checkDateIso) // Utilise la colonne de type date de Lucid
        .first()

      if (exception) {
        logger.debug(`Exception found for Driver ${driverId} on ${checkDateIso}.`)
        if (exception.is_unavailable_all_day) return false
        if (
          exception.unavailable_start_time &&
          exception.unavailable_end_time &&
          checkTimeIso >= exception.unavailable_start_time &&
          checkTimeIso < exception.unavailable_end_time
        ) {
          return false // Dans la plage d'indispo de l'exception
        }
        // En dehors de la plage horaire de l'exception ou exception mal formée -> on continue vers les règles
        logger.trace(`Outside exception time range or exception invalid.`)
      } else {
        logger.trace(`No exception on ${checkDateIso}. Checking rules.`)
      }

      // --- 2. Vérifier Règles Actives ce Jour de Semaine ---
      // Requête optimisée pour ne ramener que les règles potentiellement pertinentes
      // (même si on vérifie ensuite toutes celles du jour)
      const applicableRules = await DriverAvailabilityRule.query()
        .where('driver_id', driverId)
        .where('day_of_week', checkDayOfWeekIso)
        .where('is_active', true)
        // Optimisation possible: .where('start_time', '<=', checkTimeIso).where('end_time', '>', checkTimeIso)
        // Mais plus sûr de vérifier toutes les règles du jour pour les cas limites
        .orderBy('start_time', 'asc')

      if (applicableRules.length === 0) {
        logger.info(`No active rules for Driver ${driverId} on DoW ${checkDayOfWeekIso}.`)
        return false
      }

      // Check si dans une des plages horaires
      for (const rule of applicableRules) {
        if (checkTimeIso >= rule.start_time && checkTimeIso < rule.end_time) {
          logger.info(
            `Driver ${driverId} IS available based on rule ${rule.id} [${rule.start_time}-${rule.end_time}] at ${checkTimeIso}.`
          )
          return true
        }
      }

      // Aucune règle ne couvre cette heure
      logger.info(
        `No rules cover time ${checkTimeIso} for Driver ${driverId} on DoW ${checkDayOfWeekIso}.`
      )
      return false
    } catch (error) {
      logger.error(
        { err: error, driverId, checkTime: dateTimeToCheck.toISO() },
        'Error checking schedule avail.'
      )
      return false // Non dispo par défaut si erreur
    }
  }
}
export default new DriverAvailabilityChecker()
