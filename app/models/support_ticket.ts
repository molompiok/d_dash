// app/Models/SupportTicket.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import Client from './client.js'
import Driver from './driver.js'
import Order from './order.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

export default class SupportTicket extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare client_id: string | null

  @column()
  declare driver_id: string | null

  @column()
  declare order_id: string | null

  @column()
  declare subject: string

  @column()
  declare description: string

  @column()
  declare status: TicketStatus

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime

  // Relations
  @belongsTo(() => Client)
  declare client: BelongsTo<typeof Client>

  @belongsTo(() => Driver)
  declare driver: BelongsTo<typeof Driver>

  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>
}

export enum TicketStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
}
