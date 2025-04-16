// app/Models/Order.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, hasMany } from '@adonisjs/lucid/orm'
import Driver from './driver.js'
import OrderStatusLog from './order_status_log.js'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import db from '@adonisjs/lucid/services/db'
import GeoService from '#services/geo_service'
import Address from './address.js'
import OrderTransaction from './order_transaction.js'
import Package from './package.js'
import Client from './client.js'

export default class Order extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare client_id: string

  @column()
  declare driver_id: string | null

  @column()
  declare pickup_address_id: string

  @column()
  declare note_order: string | null

  @column()
  declare delivery_address_id: string

  @column()
  declare priority: OrderPriority

  @column()
  declare batch_id: string | null

  @column()
  declare remuneration: number

  @column()
  declare currency: string

  @column({
    consume: GeoService.wktToLineString,
    prepare: (value) => {
      const wkt = GeoService.pointsToLineString(value)
      return db.raw(`ST_GeomFromText(?, 4326)`, [wkt])
    },
  })
  declare route_geometry: { type: 'LineString'; coordinates: number[][] } | null

  @column()
  declare route_distance_meters: number | null // distance calculée

  @column()
  declare route_duration_seconds: number | null // durée calculée

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare route_instructions: object | null // Instructions si fournies

  @column() // Stocke 'valhalla' ou 'osrm'
  declare route_calculation_engine: CalculationEngine | null

  @column()
  declare order_number_in_batch: number | null

  @column()
  declare confirmation_code: string | null

  @column()
  declare client_fee: number

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare proof_of_pickup_media: string[]

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare proof_of_delivery_media: string[]

  @column()
  declare delivery_date: DateTime

  @column()
  declare cancellation_reason_code: CancellationReasonCode | null

  @column()
  declare failure_reason_code: FailureReasonCode | null

  @column()
  declare delivery_date_estimation: DateTime // estimation de la date de livraison ex: 15 avril 2025 14:30

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime
  @column()
  declare offered_driver_id: string | null // ID du driver sollicité

  @column.dateTime() // Utilise le type dateTime de Lucid pour Luxon
  declare offer_expires_at: DateTime | null // Timestamp d'expiration

  // Relation (peut être utile mais pas essentielle pour la logique d'offre)

  // Relations
  @belongsTo(() => Driver, {
    foreignKey: 'offered_driver_id',
  })
  declare offered_driver: BelongsTo<typeof Driver>

  @belongsTo(() => Client, { foreignKey: 'client_id' })
  declare client: BelongsTo<typeof Client>

  @hasMany(() => Package, { foreignKey: 'order_id' })
  declare packages: HasMany<typeof Package>

  @belongsTo(() => Address, { foreignKey: 'pickup_address_id' })
  declare pickup_address: BelongsTo<typeof Address>

  @belongsTo(() => Address, { foreignKey: 'delivery_address_id' })
  declare delivery_address: BelongsTo<typeof Address>

  @belongsTo(() => Driver)
  declare driver: BelongsTo<typeof Driver>

  @hasMany(() => OrderStatusLog)
  declare status_logs: HasMany<typeof OrderStatusLog>

  @hasMany(() => OrderTransaction)
  declare driver_payments: HasMany<typeof OrderTransaction>
}

export enum OrderStatus {
  PENDING = 'pending', // Attente assignation initiale ou après refus/expiration
  ACCEPTED = 'accepted_by_driver', // Un driver a accepté
  AT_PICKUP = 'at_pickup', // Driver arrivé au point de collecte
  EN_ROUTE_TO_DELIVERY = 'en_route_to_delivery', // Colis récupéré, en route
  AT_DELIVERY_LOCATION = 'at_delivery_location', // Driver arrivé au point de livraison
  SUCCESS = 'success', // Livraison terminée avec succès
  FAILED = 'failed', // Livraison échouée
  CANCELLED = 'cancelled', // Annulé par client ou admin
}

// Raisons de l'annulation
export enum CancellationReasonCode {
  CLIENT_REQUEST = 'client_request',
  NO_DRIVER_AVAILABLE = 'no_driver_available',
  DRIVER_CANCELLED = 'driver_cancelled', // Le driver annule après avoir accepté (via support?)
  FRAUD = 'fraud',
  ADMIN_DECISION = 'admin_decision',
  OTHER = 'other',
}

export enum CalculationEngine {
  VALHALLA = 'valhalla',
  OSRM = 'osrm',
}

export enum OrderPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export enum FailureReasonCode {
  RECIPIENT_ABSENT = 'recipient_absent',
  ADDRESS_INCORRECT = 'address_incorrect',
  PACKAGE_DAMAGED = 'package_damaged',
  ACCESS_DENIED = 'access_denied',
  OTHER = 'other',
}

// cancellation_reason_code (ENUM('client_request', 'no_driver_available', 'driver_cancelled', 'fraud', 'other'), Nullable)
// failure_reason_code (ENUM('recipient_absent', 'address_incorrect', 'package_damaged', 'access_denied', 'other'), Nullable)
