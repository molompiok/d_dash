import { DateTime } from 'luxon'
import { belongsTo, column } from '@adonisjs/lucid/orm'
import * as relations from '@adonisjs/lucid/types/relations'
import Driver from './driver.js'
import BaseModel from './base_model.js'
export default class UserDocument extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare type: DocumentType

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare driving_license_images: string[]

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare identity_document_images: string[]

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare photo: string[]

  @column()
  declare status: DocumentStatus

  @column()
  declare rejection_reason: string | null

  @column.dateTime()
  declare submitted_at: DateTime

  @column.dateTime()
  declare verified_at: DateTime | null

  @column.dateTime()
  declare driving_license_expiry_date: DateTime | null

  @column.dateTime()
  declare identity_document_expiry_date: DateTime | null

  @column()
  declare driver_id: string

  @belongsTo(() => Driver)
  declare driver: relations.BelongsTo<typeof Driver>
}

export enum DocumentType {
  CNI = 'CNI',
  PASSPORT = 'PASSPORT',
  CONSULAR = 'CONSULAR',
}

export enum DocumentStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}
