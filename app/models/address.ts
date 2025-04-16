import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import GeoService from '#services/geo_service'

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
    consume: GeoService.wktToPointAsGeoJSON,
    prepare: GeoService.pointToSQL,
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
}
