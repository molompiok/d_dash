import { DateTime } from 'luxon'
import { afterCreate, beforeCreate, belongsTo, column } from '@adonisjs/lucid/orm'
import Driver from './driver.js'
import * as relations from '@adonisjs/lucid/types/relations'
import BaseModel from './base_model.js'
interface StatusMetadata {
  reason?: string
  details?: string
  deliveryType?: string
  estimatedDuration?: string
}

export default class DriversStatus extends BaseModel {
  public static table = 'driver_statuses'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare driver_id: string

  @column()
  declare changed_at: DateTime

  @column()
  declare metadata: StatusMetadata | null

  @column()
  declare status: DriverStatus

  @column()
  declare assignments_in_progress_count: number

  @belongsTo(() => Driver, {
    foreignKey: 'driver_id',
  })
  declare driver: relations.BelongsTo<typeof Driver>


  @beforeCreate()
  static async preventDuplicateStatus(log: DriversStatus) {
    const driver = await Driver.find(log.driver_id)
    if (driver && driver.latest_status === log.status) {
      throw new Error(`Statut déjà en cours pour le livreur ${log.driver_id}, création ignorée.`)
    }
  }

  // Hook : après création, on met à jour le driver.latest_status
  @afterCreate()
  static async updateDriverLatestStatus(log: DriversStatus) {
    await Driver.query().where('id', log.driver_id).update({ latest_status: log.status })
  }
}

export enum DriverStatus {
  ACTIVE = 'active',
  PENDING = 'pending',
  IN_WORK = 'in_work',
  ON_BREAK = 'on_break',
  INACTIVE = 'inactive',
}
