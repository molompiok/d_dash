// app/commands/online_state_monitor.ts
import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import redis from '@adonisjs/redis/services/main'
import logger from '@adonisjs/core/services/logger'
import DriversStatus, { DriverStatus } from '#models/drivers_status'
import { DateTime } from 'luxon'

export default class OnlineStateMonitor extends BaseCommand {
  public static commandName = 'drivers:monitor-state'
  public static description = 'Checks for inactive online drivers and sets them to offline.'

  public static options: CommandOptions = {
    startApp: true,
  }

  private isRunning = true

  private registerShutdownHandler() {
    process.on('SIGINT', () => {
      this.isRunning = false
      logger.info('Gracefully shutting down online state monitor...')
    })
  }

  public async run() {
    logger.info('🚀 Starting Online State Monitor...')
    this.registerShutdownHandler()

    // Boucle infinie qui s'exécute toutes les minutes
    while (this.isRunning) {
      const checkStartTime = Date.now()
      logger.info('Running online state check...')

      try {
        await this.checkDrivers()
      } catch (error) {
        logger.error(error, 'An error occurred during the driver state check.')
      }
      
      const checkEndTime = Date.now()
      logger.info(`State check finished in ${checkEndTime - checkStartTime}ms.`)

      // Attendre 60 secondes avant le prochain cycle
      if (this.isRunning) {
        await new Promise(resolve => setTimeout(resolve, 60_000))
      }
    }
    
    logger.info('Online State Monitor has stopped.')
  }

  private async checkDrivers() {
    // 1. Récupérer tous les livreurs qui sont censés être en ligne
    const statusesToMonitor = [
      DriverStatus.ACTIVE, // IDLE
      DriverStatus.IN_WORK,
      DriverStatus.OFFERING,
      DriverStatus.ON_BREAK
  ];
    const onlineDrivers = await DriversStatus.query()
      .whereIn('status', statusesToMonitor)
      .distinct('driver_id')
      .pojo<{ driver_id: string }>() // Récupère seulement les IDs
    
    if (onlineDrivers.length === 0) {
      logger.info('No active drivers to monitor.')
      return
    }

    const driverIds = onlineDrivers.map(d => d.driver_id)
    const heartbeatKeys = driverIds.map(id => `driver:heartbeat:${id}`)

    // 2. Vérifier en une seule fois l'existence de leurs clés de heartbeat dans Redis
    const heartbeatExists = await redis.exists(...heartbeatKeys)

    // Si toutes les clés existent, `heartbeatExists` sera égal au nombre de clés.
    // Si `heartbeatExists` est inférieur, cela signifie qu'au moins une clé a expiré.
    if (heartbeatExists === heartbeatKeys.length) {
      logger.info(`All ${heartbeatKeys.length} active drivers have a valid heartbeat.`)
      return
    }

    // 3. Identifier les livreurs dont la clé a expiré
    for (const driverId of driverIds) {
      const keyExists = await redis.exists(`driver:heartbeat:${driverId}`)
      if (!keyExists) {
        logger.warn(`Driver ${driverId} is missing heartbeat. Setting status to inactive.`)
        // Déconnecter le livreur
        await this.deactivateDriver(driverId)
      }
    }
  }

  private async deactivateDriver(driverId: string) {
    try {
      await DriversStatus.create({
        driver_id: driverId,
        status: DriverStatus.INACTIVE,
        changed_at: DateTime.now(),
        metadata: { reason: 'inactivity_timeout' } // Raison : timeout d'inactivité
      })
      logger.info(`Driver ${driverId} successfully set to inactive due to timeout.`)
    } catch (error) {
      logger.error(error, `Failed to set driver ${driverId} to inactive.`)
    }
  }
}