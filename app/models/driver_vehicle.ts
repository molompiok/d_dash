// app/models/driver_vehicle.ts
import { DateTime } from 'luxon'
import { BaseModel, beforeCreate, belongsTo, column } from '@adonisjs/lucid/orm'
import { cuid } from '@adonisjs/core/helpers'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Driver from '#models/driver'
import VehicleMake from '#models/vehicle_make'
import VehicleModel from '#models/vehicle_model'

export enum VehicleStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  REJECTED = 'rejected',
}

export default class DriverVehicle extends BaseModel {
  @beforeCreate()
  public static assignCuid(vehicle: DriverVehicle) {
    if (!vehicle.id) {
      vehicle.id = cuid()
    }
  }

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare driver_id: string

  @column()
  declare vehicle_make_id: string

  @column()
  declare vehicle_model_id: string

  @column()
  declare type: 'car' | 'motorbike'

  @column()
  declare color: string

  @column()
  declare manufacture_year: number

  @column()
  declare license_plate: string

  @column()
  declare status: VehicleStatus

  @column({
    prepare: (value: string[]) => JSON.stringify(value || []),
    consume: (value: string) => JSON.parse(value || '[]'),
  })
  declare image_urls: string[]

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime

  // --- Relations ---
  @belongsTo(() => Driver)
  declare driver: BelongsTo<typeof Driver>

  @belongsTo(() => VehicleMake)
  declare make: BelongsTo<typeof VehicleMake>

  @belongsTo(() => VehicleModel)
  declare model: BelongsTo<typeof VehicleModel>
}