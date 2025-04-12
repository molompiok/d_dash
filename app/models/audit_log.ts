// app/Models/AuditLog.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import Order from './order.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import User from './user.js'

export default class AuditLog extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare user_id: string

  @column()
  declare action: string // ex. "assigned order", "updated status"

  @column()
  declare order_id: string | null

  @column()
  declare details: object | null // JSON object

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  // Relations

  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>

  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>
}
