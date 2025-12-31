// app/Models/Subscription.ts
import { DateTime } from 'luxon'
import { column, hasMany } from '@adonisjs/lucid/orm'
import Company from './company.js'
import SubscriptionPayment from './subscription_payment.js'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import BaseModel from './base_model.js'
export default class Subscription extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare name: string

  @column()
  declare order_limit: number

  @column()
  declare price: number

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime

  // Relations
  @hasMany(() => Company)
  declare companies: HasMany<typeof Company>

  @hasMany(() => SubscriptionPayment)
  declare payments: HasMany<typeof SubscriptionPayment>
}
