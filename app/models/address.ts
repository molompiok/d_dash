import { DateTime } from 'luxon'
import { column, hasOne } from '@adonisjs/lucid/orm'
import GeoService, { GeoJsonPoint } from '#services/geo_service'
import BaseModel from './base_model.js'
import Order from './order.js'
import type { HasOne } from '@adonisjs/lucid/types/relations'

export default class Address extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare street_address: string

  @column()
  declare city: string

  @column()
  declare postal_code: string

  @column()
  declare municipality: string | null

  @column()
  declare country: string

  @column({
    consume: (value: string | null): GeoJsonPoint | null => GeoService.hexWkbToGeoJsonPoint(value),
    prepare: (value: GeoJsonPoint | null): any => value ? GeoService.geoJsonPointToSQL(value) : null,
  })
  declare coordinates: { type: 'Point'; coordinates: number[] }

  @column()
  declare address_details: string | null

  @column()
  declare is_commercial: boolean | null

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updated_at: DateTime | null

  // Toutes les commandes où cette adresse est utilisée comme **pickup**
  @hasOne(() => Order, {
    foreignKey: 'pickup_address_id',
  })
  declare pickup_order: HasOne<typeof Order>

  // Toutes les commandes où cette adresse est utilisée comme **delivery**
  @hasOne(() => Order, {
    foreignKey: 'delivery_address_id',
  })
  declare delivery_order: HasOne<typeof Order>
}
