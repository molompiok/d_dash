import { column, beforeCreate, hasOne, hasMany, belongsTo } from '@adonisjs/lucid/orm'
import { compose, cuid } from '@adonisjs/core/helpers'
import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'
import { DbAccessTokensProvider } from '@adonisjs/auth/access_tokens'
import hash from '@adonisjs/core/services/hash'
import { DateTime } from 'luxon'
import BaseModel from './base_model.js'
// Relations
import Client from './client.js'
import Driver from './driver.js'
import UserDocument from './user_document.js'
import AuditLog from './audit_log.js'
import Notification from './notification.js'
import OrderStatusLog from './order_status_log.js'
import RatingDriver from './rating_driver.js'
import AuthAccessToken from './auth_access_token.js'
import * as relations from '@adonisjs/lucid/types/relations'

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
  declare google_id: string | null

  @column()
  declare facebook_id: string | null

  @column()
  declare user_document_id: string | null


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

  // Relations classiques
  @hasOne(() => Client, { foreignKey: 'user_id', localKey: 'id' })
  declare client: relations.HasOne<typeof Client>

  @hasOne(() => Driver, { foreignKey: 'user_id', localKey: 'id' })
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

  @belongsTo(() => UserDocument)
  declare user_document: relations.BelongsTo<typeof UserDocument>

  static accessTokens = DbAccessTokensProvider.forModel(User)


  @hasMany(() => AuthAccessToken, {
    foreignKey: 'tokenableId', // important si tu suis AdonisJS 6 conventions
  })
  declare tokens: relations.HasMany<typeof AuthAccessToken>

  @beforeCreate()
  public static assignCuid(user: User) {
    if (!user.id) {
      user.id = cuid()
    }
  }
}

export enum RoleType {
  ADMIN = 'admin',
  CLIENT = 'client',
  DRIVER = 'driver',
}

