// app/models/user_document.ts
import { DateTime } from 'luxon'
import { BaseModel, beforeCreate, belongsTo, column } from '@adonisjs/lucid/orm'
import { cuid } from '@adonisjs/core/helpers'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Driver from '#models/driver'

// Enum pour les types de documents, basé sur votre frontend
export enum DocumentType {
  NATIONAL_ID = 'NATIONAL_ID',
  DRIVER_LICENSE = 'DRIVER_LICENSE',
  SELFIE = 'SELFIE',
  VEHICLE_PHOTOS = 'VEHICLE_PHOTOS',
  // Ajoutez d'autres types si nécessaire
}

// Enum pour les statuts
export enum DocumentStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export default class UserDocument extends BaseModel {
  @beforeCreate()
  public static assignCuid(doc: UserDocument) {
    if (!doc.id) {
      doc.id = cuid()
    }
  }

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare driver_id: string

  @column()
  declare type: DocumentType

  @column()
  declare status: DocumentStatus

  // On s'assure que les URLs sont toujours un tableau de chaînes de caractères
  @column({
    prepare: (value: string[]) => JSON.stringify(value || []),
    consume: (value: string) => JSON.parse(value || '[]'),
  })
  declare file_urls: string[]

  @column()
  declare metadata: Record<string, any> | null

  @column()
  declare rejection_reason: string | null

  @column.dateTime()
  declare verified_at: DateTime | null
  
  @column.dateTime()
  declare submitted_at: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime

  // Relation avec le modèle Driver
  @belongsTo(() => Driver)
  declare driver: BelongsTo<typeof Driver>
}