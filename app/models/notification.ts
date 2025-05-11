// app/Models/Notification.ts
import { DateTime } from 'luxon'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import Order from './order.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import User from './user.js'
import BaseModel from './base_model.js'
export default class Notification extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare recipient_user_id: string

  @column()
  declare order_id: string | null

  @column()
  declare type: NotificationType

  @column()
  declare channel: NotificationChannel

  @column()
  declare message: string

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  // Relations
  @column()
  declare read_at: DateTime | null

  @column()
  declare sent_at: DateTime | null

  @belongsTo(() => User, { foreignKey: 'recipient_user_id' })
  declare user: BelongsTo<typeof User>

  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>
}

export enum NotificationChannel {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
  IN_APP = 'in_app',
}

export enum NotificationType {
  NEW_MISSION_OFFER = 'NEW_MISSION_OFFER',
  MISSION_UPDATE = 'MISSION_UPDATE',
  PAYMENT_SUCCESS = 'PAYMENT_SUCCESS',
  VEHICLE_STATUS_UPDATE = 'VEHICLE_STATUS_UPDATE',
  DOCUMENT_STATUS_UPDATE = 'DOCUMENT_STATUS_UPDATE',
  SUPPORT_MESSAGE = 'SUPPORT_MESSAGE',
  SCHEDULE_REMINDER = 'SCHEDULE_REMINDER',
  GENERAL_INFO = 'GENERAL_INFO',

}
