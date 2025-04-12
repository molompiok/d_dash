// app/Models/SubscriptionPayment.ts
import { BaseModel, belongsTo, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'
import Client from './client.js'
import Subscription from './subscription.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

export default class SubscriptionPayment extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare client_id: string

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
  @belongsTo(() => Client)
  declare client: BelongsTo<typeof Client>

  @belongsTo(() => Subscription)
  declare subscription: BelongsTo<typeof Subscription>
}
