// app/Models/Subscription.ts
import { DateTime } from 'luxon'
import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
import Client from './client.js'
import SubscriptionPayment from './subscription_payment.js'
import type { HasMany } from '@adonisjs/lucid/types/relations'

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
  @hasMany(() => Client)
  declare clients: HasMany<typeof Client>

  @hasMany(() => SubscriptionPayment)
  declare payments: HasMany<typeof SubscriptionPayment>
}
