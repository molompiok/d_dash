// app/Models/OrderStatusLog.ts
import { DateTime } from 'luxon'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import Order, { OrderStatus } from './order.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import GeoService from '#services/geo_service'
import User from './user.js'
import BaseModel from './base_model.js'
export interface StatusMetadata {
  reason: string
  details?: string
  deliveryType?: string
}
export default class OrderStatusLog extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare order_id: string

  @column()
  declare status: OrderStatus

  @column.dateTime({ autoCreate: true })
  declare changed_at: DateTime

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column()
  declare metadata: StatusMetadata | null

  @column()
  declare changed_by_user_id: string

  @column({
    consume: GeoService.wktToPointAsGeoJSON,
    prepare: GeoService.pointToSQL,
  })
  declare current_location: { type: 'Point'; coordinates: number[] }

  // Relations
  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>

  @belongsTo(() => User, { foreignKey: 'changed_by_user_id' })
  declare changed_by_user: BelongsTo<typeof User>
}
