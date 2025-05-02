// app/Models/Client.ts
import { DateTime } from 'luxon'
import { column, hasMany, belongsTo, beforeCreate } from '@adonisjs/lucid/orm'
import type { HasMany, BelongsTo } from '@adonisjs/lucid/types/relations'
import Order from './order.js'
import SubscriptionPayment from './subscription_payment.js'
import Subscription from './subscription.js'
import User from './user.js'
import { cuid } from '@adonisjs/core/helpers'
import BaseModel from './base_model.js'

export default class Client extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare user_id: string

  @column()
  declare api_key: string

  @column()
  declare subscription_id: string

  @column()
  declare company_name: string | null

  @column()
  declare order_count: number

  @column()
  declare fcm_token: string | null

  @column()
  declare is_valid_client: boolean

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime

  // Relations
  @hasMany(() => Order)
  declare orders: HasMany<typeof Order>

  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>

  @hasMany(() => SubscriptionPayment)
  declare subscription_payments: HasMany<typeof SubscriptionPayment>

  @belongsTo(() => Subscription)
  declare subscription: BelongsTo<typeof Subscription>

  @beforeCreate()
  public static assignCuid(client: Client) {
    if (!client.id) {
      client.id = cuid()
    }
  }
}
