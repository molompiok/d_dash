import { DateTime } from 'luxon'
import hash from '@adonisjs/core/services/hash'
import { compose } from '@adonisjs/core/helpers'
import { BaseModel, column, hasMany, hasOne } from '@adonisjs/lucid/orm'
import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'
import { DbAccessTokensProvider } from '@adonisjs/auth/access_tokens'
import Client from './client.js'
import * as relations from '@adonisjs/lucid/types/relations'
import Driver from './driver.js'
import UserDocument from './user_document.js'
import AuditLog from './audit_log.js'
import Notification from './notification.js'
import OrderStatusLog from './order_status_log.js'
import RatingDriver from './rating_driver.js'

const AuthFinder = withAuthFinder(() => hash.use('scrypt'), {
  uids: ['email'],
  passwordColumnName: 'password',
})

export default class User extends compose(BaseModel, AuthFinder) {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare full_name: string

  @column()
  declare is_active: boolean

  @column()
  declare role: RoleType

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare phone: string[]

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare photo: string[]

  @column()
  declare email: string

  @column({ serializeAs: null })
  declare password: string

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime | null

  @hasOne(() => Client)
  declare client: relations.HasOne<typeof Client>

  @hasOne(() => Driver)
  declare driver: relations.HasOne<typeof Driver>

  @hasMany(() => UserDocument)
  declare documents: relations.HasMany<typeof UserDocument>

  @hasMany(() => AuditLog)
  declare audit_logs: relations.HasMany<typeof AuditLog>

  @hasMany(() => Notification, { foreignKey: 'recipient_user_id' })
  declare notifications: relations.HasMany<typeof Notification>

  @hasMany(() => OrderStatusLog, { foreignKey: 'changed_by_user_id' })
  declare order_status_logs: relations.HasMany<typeof OrderStatusLog>

  @hasMany(() => RatingDriver, { foreignKey: 'rater_user_id' })
  declare ratings: relations.HasMany<typeof RatingDriver>

  static accessTokens = DbAccessTokensProvider.forModel(User)
}
export enum RoleType {
  ADMIN = 'admin',
  CLIENT = 'client',
  DRIVER = 'driver',
}
