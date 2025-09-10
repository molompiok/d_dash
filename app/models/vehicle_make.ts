// app/models/vehicle_make.ts
import { DateTime } from 'luxon'
import { BaseModel, beforeCreate, column, hasMany } from '@adonisjs/lucid/orm'
import { cuid } from '@adonisjs/core/helpers'
import VehicleModel from '#models/vehicle_model'
import type { HasMany } from '@adonisjs/lucid/types/relations'

export default class VehicleMake extends BaseModel {
  @beforeCreate()
  public static assignCuid(make: VehicleMake) {
    if (!make.id) {
      make.id = cuid()
    }
  }

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare name: string

  @column()
  declare type: 'car' | 'motorbike'

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime

  // Une marque a plusieurs modèles
  @hasMany(() => VehicleModel)
  declare vehicleModels: HasMany<typeof VehicleModel>
}