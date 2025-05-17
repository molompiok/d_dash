// app/Models/OrderStatusLog.ts
import { DateTime } from 'luxon'
import { column, belongsTo } from '@adonisjs/lucid/orm'
import Order, { OrderStatus } from './order.js'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import GeoService, { GeoJsonPoint } from '#services/geo_service'
import User from './user.js'
import BaseModel from './base_model.js'
import db from '@adonisjs/lucid/services/db'
export interface StatusMetadata {
  reason?: string
  details?: string
  waypoint_sequence: number
  waypoint_status?: string
  waypoint_type?: string

}
export default class OrderStatusLog extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare order_id: string

  @column()
  declare status: OrderStatus

  @column.dateTime({ autoCreate: true })
  declare changed_at: DateTime

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column()
  declare metadata: StatusMetadata | null

  @column()
  declare changed_by_user_id: string

  @column({
    consume: (valueFromDb: string | null) => GeoService.ewkbHexToGeoJsonPoint(valueFromDb),
    prepare: (valueForDb: GeoJsonPoint | null) => {
      const wktString = GeoService.geoJsonPointToWkt(valueForDb);
      if (wktString === null) {
        return null; // Permet de stocker NULL dans la base de données si l'objet est invalide/null
      }
      // Le SRID 4326 est commun pour les coordonnées géographiques (latitude/longitude)
      return db.raw(`ST_GeomFromText(?, 4326)`, [wktString]);
    },
  })
  declare current_location: { type: 'Point'; coordinates: number[] }

  // Relations
  @belongsTo(() => Order)
  declare order: BelongsTo<typeof Order>

  @belongsTo(() => User, { foreignKey: 'changed_by_user_id' })
  declare changed_by_user: BelongsTo<typeof User>

}
