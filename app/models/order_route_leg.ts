// app/models/order_route_leg.ts
import { DateTime } from 'luxon'
import { column, belongsTo, beforeCreate } from '@adonisjs/lucid/orm' // BaseModel si tu l'utilises
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Order from '#models/order'
import Address from '#models/address' // Si tu stockes des ID d'adresses pour start/end waypoints
import db from '@adonisjs/lucid/services/db' // IMPORTANT pour db.raw
import GeoService from '#services/geo_service' // Assure-toi que le chemin est correct
import { cuid } from '@adonisjs/core/helpers' // Pour générer les ID
import BaseModel from './base_model.js'
// Interface pour les manœuvres (peut être affinée selon la structure de Valhalla)


export default class OrderRouteLeg extends BaseModel { // Ou import { BaseModel } from '@adonisjs/lucid/orm'
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare order_id: string

  @column()
  declare leg_sequence: number // Ordre du leg dans la mission (0, 1, 2...)

  // Optionnel: Stocker les ID des adresses de début/fin du leg si elles correspondent à des waypoints prédéfinis
  @column()
  declare start_address_id: string | null // FK vers Address, null si départ de la position du livreur

  @column()
  declare end_address_id: string | null // FK vers Address

  // Alternative ou complément : stocker les coordonnées de début/fin brutes
  @column({
    consume: (value: string | null) => value ? GeoService.ewkbHexToGeoJsonPoint(value) : null,
    prepare: (value: { type: 'Point'; coordinates: [number, number] } | null) =>
      value ? db.raw(`ST_SetSRID(ST_MakePoint(?, ?), 4326)`, [value.coordinates[0], value.coordinates[1]]) : null,
  })
  declare start_coordinates: { type: 'Point'; coordinates: [number, number] } | null // lon, lat

  @column({
    consume: (value: string | null) => value ? GeoService.ewkbHexToGeoJsonPoint(value) : null,
    prepare: (value: { type: 'Point'; coordinates: [number, number] } | null) =>
      value ? db.raw(`ST_SetSRID(ST_MakePoint(?, ?), 4326)`, [value.coordinates[0], value.coordinates[1]]) : null,
  })
  declare end_coordinates: { type: 'Point'; coordinates: [number, number] } | null // lon, lat

  @column({
    consume: (valueFromDb: string | null) => GeoService.ewkbHexToGeoJsonLineString(valueFromDb),
    prepare: (value: { type: 'LineString'; coordinates: number[][] } | null) => {
      if (!value || !value.coordinates || value.coordinates.length < 2) return null
      // Assurez-vous que GeoService.geoJsonLineStringToWkt existe et prend un GeoJSON LineString
      const wkt = GeoService.geoJsonLineStringToWkt(value) // Ou `GeoService.pointsToLineString(value)` si elle attend un GeoJSON
      if (!wkt) return null
      return db.raw(`ST_GeomFromText(?, 4326)`, [wkt])
    },
  })
  declare geometry: { type: 'LineString'; coordinates: number[][] } | null

  @column()
  declare duration_seconds: number | null

  @column()
  declare distance_meters: number | null

  @column({
    prepare: (value: LegManeuver[] | null) => value ? JSON.stringify(value) : null,
    // consume: (value: string | null): LegManeuver[] | null => value ? JSON.parse(value) : null,
  })
  declare maneuvers: LegManeuver[] | null

  // Optionnel: stocker la réponse brute du leg Valhalla pour débogage ou infos supplémentaires
  @column({
    prepare: (value: object | null) => value ? JSON.stringify(value) : null,
    // consume: (value: string | null) => value ? JSON.parse(value) : null,
  })
  declare raw_valhalla_leg_data: object | null


  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime

  // Relations
  @belongsTo(() => Order, { foreignKey: 'order_id' })
  declare order: BelongsTo<typeof Order>

  @belongsTo(() => Address, { foreignKey: 'start_address_id' })
  declare start_address: BelongsTo<typeof Address>

  @belongsTo(() => Address, { foreignKey: 'end_address_id' })
  declare end_address: BelongsTo<typeof Address>

  @belongsTo(() => OrderRouteLeg, { foreignKey: 'order_id' })
  declare order_route_leg: BelongsTo<typeof OrderRouteLeg>

  // Hook pour générer CUID avant la création
  @beforeCreate()
  public static assignCuid(orderRouteLeg: OrderRouteLeg) {
    if (!orderRouteLeg.id) {
      orderRouteLeg.id = cuid()
    }
  }
}


export interface LegManeuver {
  instruction: string;
  type: number; // Type de manœuvre Valhalla
  distance: number; // Distance jusqu'à cette manœuvre depuis le début du leg (en mètres)
  time: number;   // Temps estimé jusqu'à cette manœuvre (en secondes)
  begin_shape_index: number; // Index sur la polyline du leg où la manœuvre commence
  end_shape_index: number;   // Index sur la polyline du leg où la manœuvre se termine
  // street_names?: string[]; // Noms des rues
  // ...autres champs utiles de Valhalla (ex: verbal_pre_transition_instruction)
}