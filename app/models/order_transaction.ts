import { DateTime } from 'luxon'
import { column, belongsTo, beforeCreate } from '@adonisjs/lucid/orm'
import Driver from './driver.js'
import Order from './order.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Client from './client.js'
import BaseModel from './base_model.js'
import { cuid } from '@adonisjs/core/helpers'
export default class OrderTransaction extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare driver_id: string

  @column()
  declare order_id: string | null

  @column()
  declare currency: string

  @column()
  declare client_id: string

  @column()
  declare type: OrderTransactionType

  @column()
  declare transaction_reference: string

  //visa , mastercard, paypal, etc
  @column()
  declare payment_method: PaymentMethod

  @column()
  declare amount: number

  @column()
  declare status: OrderTransactionStatus

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare history_status: { status: OrderTransactionStatus, timestamp: string }[]

  @column()
  declare metadata: Record<string, any>

  @column.dateTime()
  declare payment_date: DateTime

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime

  // Relations
  @belongsTo(() => Driver)
  declare driver: BelongsTo<typeof Driver>

  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>

  @belongsTo(() => Client)
  declare client: BelongsTo<typeof Client>

  @beforeCreate()
  public static async assignCuid(transaction: OrderTransaction) {
    if (!transaction.id) {
      transaction.id = cuid()
    }
  }
}
export enum PaymentMethod {
  MTN = 'mtn',
  ORANGE = 'orange',
  MOOV = 'moov',
  WAVE = 'wave',
}

export enum OrderTransactionStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
}

export enum OrderTransactionType {
  DRIVER_PAYMENT = 'driver_payment',
  DRIVER_PENALTY = 'driver_penalty',
  DRIVER_REFUND = 'driver_refund',
  DRIVER_WITHDRAWAL = 'driver_withdrawal',
  DRIVER_BONUS = 'driver_bonus',
  CLIENT_REIMBURSEMENT = 'client_reimbursement',
  CLIENT_PAYMENT = 'client_payment'
}
