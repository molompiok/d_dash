import { DateTime } from 'luxon'
import { BaseModel, belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Driver from '#models/driver' // Assure-toi que le chemin d'import est correct

export default class DriverAvailabilityRule extends BaseModel {
  public static table = 'driver_availability_rules' // Nom de table en snake_case

  @column({ isPrimary: true })
  declare id: string // UUID

  @column()
  declare driver_id: string

  /**
   * Jour de la semaine (0 = Dimanche, 1 = Lundi, ..., 6 = Samedi)
   */
  @column()
  declare day_of_week: number

  /**
   * Heure de début de disponibilité (format HH:mm:ss, **stocké en UTC recommandé**)
   */
  @column({
    prepare: (value: string | null) => value ?? null, // Gère la préparation pour la BDD
    consume: (value: string | null) => value ?? null, // Gère la récupération depuis la BDD
  })
  declare start_time: string // Représenté comme string, ex: '09:00:00'

  /**
   * Heure de fin de disponibilité (format HH:mm:ss, **stocké en UTC recommandé**)
   */
  @column({
    prepare: (value: string | null) => value ?? null,
    consume: (value: string | null) => value ?? null,
  })
  declare end_time: string // Représenté comme string, ex: '17:30:00'

  @column()
  declare is_active: boolean

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime | null

  @belongsTo(() => Driver)
  declare driver: BelongsTo<typeof Driver>
}
