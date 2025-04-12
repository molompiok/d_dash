// app/Models/OrderStatusLog.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import Order, { OrderStatus } from './order.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { Point } from 'geojson'
import GeoService from '#services/geo_service'
import User from './user.js'

export default class OrderStatusLog extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare order_id: string

  @column()
  declare status: OrderStatus

  @column.dateTime({ autoCreate: true })
  declare changed_at: DateTime

  @column()
  declare changed_by_user_id: string

  @column({
    consume: GeoService.wktToPointAsGeoJSON,
    prepare: GeoService.pointToSQL,
  })
  declare current_location: { type: 'Point'; coordinates: Point }

  // Relations
  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>

  @belongsTo(() => User, { foreignKey: 'changed_by_user_id' })
  declare changed_by_user: BelongsTo<typeof User>
}
