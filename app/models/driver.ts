// app/Models/Driver.ts
import { beforeCreate, belongsTo, column, hasMany, hasOne } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import Order from './order.js'
import type { BelongsTo, HasMany, HasOne } from '@adonisjs/lucid/types/relations'
import DriverAvailabilityRule from './driver_availability_rule.js'
import DriverAvailabilityException from './driver_availability_exception.js'
import GeoService from '#services/geo_service'
import DriverVehicle from './driver_vehicle.js'
import UserDocument from './user_document.js'
import OrderTransaction, { PaymentMethod } from './order_transaction.js'
import User from './user.js'
import DriversStatus, { DriverStatus } from './drivers_status.js'
import { cuid } from '@adonisjs/core/helpers'
import BaseModel from './base_model.js'

type Status = 'success' | 'accept' | 'refuse' | 'failure'

interface DeliveryStat {
  status: Status
  timestamp: string // ou Date
}


interface MobileMoney {
  number: PaymentMethod
  provider: string
  status: 'active' | 'inactive'
}

export default class Driver extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare user_id: string

  @column()
  declare client_id: string | null // Client propriétaire du livreur

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare mobile_money: MobileMoney[]


  @column({
    consume: GeoService.wktToGeoJsonPoint,
    prepare: GeoService.pointToWkt,
  })
  declare current_location: { type: 'Point'; coordinates: number[] } | null // Type geometry (PostGIS)

  @column()
  declare average_rating: number

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare delivery_stats: Record<string, DeliveryStat>

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime

  @column()
  declare fcm_token: string | null

  @column()
  declare latest_status: DriverStatus | null

  // Relations
  @hasMany(() => DriversStatus, { foreignKey: 'driver_id' })
  declare statusLogs: HasMany<typeof DriversStatus>

  @hasMany(() => Order, { foreignKey: 'driver_id' })
  declare orders: HasMany<typeof Order>

  @column()
  declare is_valid_driver: boolean

  @belongsTo(() => User, { foreignKey: 'user_id' })
  declare user: BelongsTo<typeof User>

  @hasMany(() => DriverVehicle, { foreignKey: 'driver_id' })
  declare vehicles: HasMany<typeof DriverVehicle>

  @hasMany(() => OrderTransaction, { foreignKey: 'driver_id' })
  declare payments: HasMany<typeof OrderTransaction>

  @hasOne(() => UserDocument, { foreignKey: 'driver_id' })
  declare user_document: HasOne<typeof UserDocument>

  @hasMany(() => DriverAvailabilityRule, { foreignKey: 'driver_id' })
  declare availability_rules: HasMany<typeof DriverAvailabilityRule>

  @hasMany(() => DriverAvailabilityException, { foreignKey: 'driver_id' })
  declare availability_exceptions: HasMany<typeof DriverAvailabilityException>

  @beforeCreate() // Hook pour générer le CUID
  public static assignCuid(driver: Driver) {
    if (!driver.id) {
      driver.id = cuid()
    }
  }
}
