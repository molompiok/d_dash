import { DateTime } from 'luxon'
import { belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Driver from '#models/driver' // Assure-toi que le chemin d'import est correct
import BaseModel from './base_model.js'
export default class DriverAvailabilityException extends BaseModel {
  public static table = 'driver_availability_exceptions'

  @column({ isPrimary: true })
  declare id: string // 

  @column()
  declare driver_id: string

  /**
   * Date spécifique de l'exception
   */
  @column.date()
  declare exception_date: DateTime // Utilise le type Date de Luxon

  @column()
  declare is_unavailable_all_day: boolean

  /**
   * Heure de début d'indisponibilité (si pas toute la journée, format HH:mm:ss, UTC)
   */
  @column({
    prepare: (value: string | null) => value ?? null,
    consume: (value: string | null) => value ?? null,
  })
  declare unavailable_start_time: string | null

  /**
   * Heure de fin d'indisponibilité (si pas toute la journée, format HH:mm:ss, UTC)
   */
  @column({
    prepare: (value: string | null) => value ?? null,
    consume: (value: string | null) => value ?? null,
  })
  declare unavailable_end_time: string | null

  /**
   * Raison optionnelle (vacances, maladie, etc.)
   */
  @column()
  declare reason: string | null

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime | null

  @belongsTo(() => Driver)
  declare driver: BelongsTo<typeof Driver>
}
