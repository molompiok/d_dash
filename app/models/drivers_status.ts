import { DateTime } from 'luxon'
import { BaseModel, belongsTo, column } from '@adonisjs/lucid/orm'
import Driver from './driver.js'
import * as relations from '@adonisjs/lucid/types/relations'
import User from './user.js'

interface StatusMetadata {
  reason?: string
  details?: string
  deliveryType?: string
  estimatedDuration?: string
}

export default class DriversStatus extends BaseModel {
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
}

export enum DriverStatus {
  ACTIVE = 'active',
  PENDING = 'pending',
  IN_WORK = 'in_work',
  ON_BREAK = 'on_break',
  INACTIVE = 'inactive',
}
