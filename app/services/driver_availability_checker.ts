// app/services/driver_availability_checker.ts
import { DateTime } from 'luxon'
import DriverAvailabilityRule from '#models/driver_availability_rule'
import logger from '@adonisjs/core/services/logger'

class DriverAvailabilityChecker {

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

      const applicableRules = await DriverAvailabilityRule.query()
        .where('driver_id', driverId)
        .where('day_of_week', checkDayOfWeekIso)
        .where('is_active', true)

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
