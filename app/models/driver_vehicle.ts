// app/Modules/Drivers/Models/DriverVehicle.ts
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import Driver from './driver.js'

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

  @column()
  declare model: string | null

  @column()
  declare color: string | null

  @column()
  declare max_weight_kg: number

  @column()
  declare max_volume_m3: number

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime

  @belongsTo(() => Driver)
  declare driver: BelongsTo<typeof Driver>
}

export enum VehicleType {
  Bicycle = 'bicycle',
  Scooter = 'scooter',
  Car = 'car',
  Van_Small = 'van_small',
  Van_Large = 'van_large',
  Truck = 'truck',
  Motorcycle = 'motorcycle',
  Walker = 'walker',
}

export enum VehicleStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PENDING = 'pending',
  MAINTENANCE = 'maintenance',
}
