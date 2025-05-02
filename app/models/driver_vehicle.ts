// app/Modules/Drivers/Models/DriverVehicle.ts
import { column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import Driver from './driver.js'
import BaseModel from './base_model.js'
export default class DriverVehicle extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare driver_id: string

  @column()
  declare type: VehicleType

  @column()
  declare license_plate: string | null

  @column.date()
  declare insurance_expiry_date: DateTime | null

  @column()
  declare has_refrigeration: boolean

  @column()
  declare status: VehicleStatus

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare vehicle_image: string[]

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare license_image: string[]

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare vehicle_document: string[]

  @column()
  declare model: string | null

  @column()
  declare color: string | null

  @column()
  declare max_weight_kg: number

  @column({ columnName: 'max_volume_m3' })
  declare max_volume_m3: number

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime

  @belongsTo(() => Driver, {
    foreignKey: 'driver_id',
    localKey: 'id',
  })
  declare driver: BelongsTo<typeof Driver>
}

export enum VehicleType {
  Car = 'car',
  Truck = 'truck',
  Motorcycle = 'motorcycle',
}

export enum VehicleStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  REJECTED = 'rejected',
  PENDING = 'pending',
  MAINTENANCE = 'maintenance',
}
