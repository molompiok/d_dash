// app/Models/AuthAccessToken.ts
import { DateTime } from 'luxon'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import User from './user.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import BaseModel from './base_model.js'
export default class AuthAccessToken extends BaseModel {
  static table = 'auth_access_tokens'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare tokenableId: string

  @column()
  declare type: string

  @column()
  declare name: string | null

  @column()
  declare hash: string

  @column()
  declare abilities: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @column.dateTime()
  declare lastUsedAt: DateTime | null

  @column.dateTime()
  declare expiresAt: DateTime | null

  /**
   * Relation avec User
   */
  @belongsTo(() => User, {
    localKey: 'id',
    foreignKey: 'tokenableId',
  })
  declare user: BelongsTo<typeof User>
}
