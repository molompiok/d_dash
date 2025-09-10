// app/models/driver_location_log.ts
import { DateTime } from 'luxon'
import { beforeCreate, belongsTo, column } from '@adonisjs/lucid/orm'
import { cuid } from '@adonisjs/core/helpers'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Driver from '#models/driver'
import GeoService from '#services/geo_service' // Vous utilisez déjà ce service
import type { GeoJsonPoint } from '#services/geo_service' // Type défini dans votre projet
import BaseModel from './base_model.js'

export default class DriverLocationLog extends BaseModel {
  public static table = 'driver_location_logs'

  @beforeCreate()
  public static assignCuid(log: DriverLocationLog) {
    if (!log.id) {
      log.id = cuid()
    }
  }

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare driver_id: string

  @column({
    // Ces fonctions prepare/consume sont basées sur vos modèles existants
    consume: GeoService.wktToGeoJsonPoint,
    prepare: GeoService.pointToWkt,
  })
  declare location: GeoJsonPoint | null

  @column()
  declare accuracy: number | null

  @column()
  declare speed: number | null

  @column()
  declare heading: number | null

  @column({ columnName: 'battery_level' })
  declare batteryLevel: number | null

  @column({ columnName: 'is_moving' })
  declare isMoving: boolean | null

  @column.dateTime()
  declare timestamp: DateTime

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @belongsTo(() => Driver)
  declare driver: BelongsTo<typeof Driver>
}