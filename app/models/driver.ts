// app/Models/Driver.ts
import { BaseModel, belongsTo, column, hasMany, hasOne } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import Order from './order.js'
import DriverPayment from './order_transaction.js'
import type { BelongsTo, HasMany, HasOne } from '@adonisjs/lucid/types/relations'
import type { Point } from 'geojson'
import DriverAvailabilityRule from './driver_availability_rule.js'
import DriverAvailabilityException from './driver_availability_exception.js'
import GeoService from '#services/geo_service'
import DriverVehicle from './driver_vehicle.js'
import UserDocument from './user_document.js'
import OrderTransaction from './order_transaction.js'
import User from './user.js'
import DriversStatus, { DriverStatus } from './drivers_status.js'

interface DeliveryStats {
  success: number
  failure: number
  total: number
}

export default class Driver extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare user_id: string

  @column()
  declare client_id: string | null // Client propriétaire du livreur

  @column()
  declare user_document_id: string

  @column({
    consume: GeoService.wktToPointAsGeoJSON,
    prepare: GeoService.pointToSQL,
  })
  declare current_location: { type: 'Point'; coordinates: number[] } | null // Type geometry (PostGIS)

  @column()
  declare average_rating: number

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare delivery_stats: DeliveryStats

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime

  @column()
  declare latest_status: DriverStatus | null

  // Relations
  @hasMany(() => DriversStatus)
  declare statusLogs: HasMany<typeof DriversStatus>

  @hasMany(() => Order)
  declare orders: HasMany<typeof Order>

  @belongsTo(() => User, { foreignKey: 'user_id' })
  declare user: BelongsTo<typeof User>

  @hasMany(() => DriverVehicle)
  declare vehicles: HasMany<typeof DriverVehicle>

  @hasMany(() => OrderTransaction)
  declare payments: HasMany<typeof OrderTransaction>

  @belongsTo(() => UserDocument)
  declare user_document: BelongsTo<typeof UserDocument>

  @hasMany(() => DriverAvailabilityRule)
  declare availability_rules: HasMany<typeof DriverAvailabilityRule>

  @hasMany(() => DriverAvailabilityException)
  declare availability_exceptions: HasMany<typeof DriverAvailabilityException>
}
