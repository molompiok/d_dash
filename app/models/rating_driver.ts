import { column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import User from './user.js'
import Driver from './driver.js'
import Order from './order.js'
import BaseModel from './base_model.js'
export default class RatingDriver extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare order_id: string

  @column()
  declare rater_user_id: string

  @column()
  declare rated_driver_id: string

  @column()
  declare rating_score: number

  @column()
  declare comment: string | null

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  // Relations
  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>

  @belongsTo(() => User, {
    foreignKey: 'rater_user_id',
  })
  declare rater: BelongsTo<typeof User>

  @belongsTo(() => Driver, {
    foreignKey: 'rated_driver_id',
  })
  declare driver: BelongsTo<typeof Driver>
}
