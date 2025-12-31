// app/Models/SubscriptionPayment.ts
import { column, belongsTo } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import Company from './company.js'
import Subscription from './subscription.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import BaseModel from './base_model.js'
export default class SubscriptionPayment extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare company_id: string

  @column()
  declare subscription_id: string

  @column()
  declare amount: number

  @column()
  declare status: 'pending' | 'completed' | 'failed'

  @column.dateTime()
  declare payment_date: DateTime

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime | null

  // Relations
  @belongsTo(() => Company)
  declare company: BelongsTo<typeof Company>

  @belongsTo(() => Subscription)
  declare subscription: BelongsTo<typeof Subscription>
}
