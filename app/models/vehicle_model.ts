// app/models/vehicle_model.ts
import { DateTime } from 'luxon'
import { BaseModel, beforeCreate, belongsTo, column } from '@adonisjs/lucid/orm'
import { cuid } from '@adonisjs/core/helpers'
import VehicleMake from '#models/vehicle_make'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

export default class VehicleModel extends BaseModel {
  @beforeCreate()
  public static assignCuid(model: VehicleModel) {
    if (!model.id) {
      model.id = cuid()
    }
  }

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare name: string

  @column()
  declare vehicle_make_id: string

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime

  // Un modèle appartient à une marque
  @belongsTo(() => VehicleMake)
  declare vehicleMake: BelongsTo<typeof VehicleMake>
}