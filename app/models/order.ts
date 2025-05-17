// app/models/order.ts
import { DateTime } from 'luxon'
import { column, belongsTo, hasMany } from '@adonisjs/lucid/orm' // BaseModel si tu l'utilises
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import Driver from '#models/driver'
import Client from '#models/client'
import Address from '#models/address'
import Package from '#models/package'
import OrderStatusLog from '#models/order_status_log'
import OrderTransaction from '#models/order_transaction'
import OrderRouteLeg from '#models/order_route_leg' // NOUVEAU : Importer le nouveau modèle
import BaseModel from './base_model.js'
// Tes enums existants (OrderStatus, CancellationReasonCode, etc.) restent ici
export enum OrderStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted_by_driver',
  AT_PICKUP = 'at_pickup',
  EN_ROUTE_TO_DELIVERY = 'en_route_to_delivery',
  EN_ROUTE_TO_PICKUP = 'en_route_to_pickup',
  AT_DELIVERY_LOCATION = 'at_delivery_location',
  PARTIALLY_COMPLETED = 'partially_completed',
  SUCCESS = 'success',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum CancellationReasonCode {
  CLIENT_REQUEST = 'client_request',
  NO_DRIVER_AVAILABLE = 'no_driver_available',
  DRIVER_CANCELLED = 'driver_cancelled',
  FRAUD = 'fraud',
  ADMIN_DECISION = 'admin_decision',
  OTHER = 'other',
}

export enum FailureReasonCode {
  RECIPIENT_ABSENT = 'recipient_absent',
  ADDRESS_INCORRECT = 'address_incorrect',
  PACKAGE_DAMAGED = 'package_damaged',
  ACCESS_DENIED = 'access_denied',
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

export enum waypointStatus {
  PENDING = 'pending',
  ARRIVED = 'arrived',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  SKIPPED = 'skipped',
  FAILED = 'failed',
}

// Type pour le résumé des waypoints
export interface WaypointSummaryItem {
  type: 'pickup' | 'delivery';
  address_id: string; // ou l'objet Address complet si besoin pour affichage
  address_text?: string; // Peut être utile pour le front
  coordinates: [number, number]; // lon, lat
  photo_urls?: string[];
  confirmation_code: string; //confirmation code sera demande par le client au livreur , et assi demande par le livreur au client selon le type de waypoint
  notes?: string;
  sequence: number; //Sequence du waypoint dans la commande
  status?: waypointStatus; // Pour suivre l'état de chaque waypoint
  name?: string; // Nom du colis pour pickup, nom du destinataire pour delivery
  start_at: DateTime | null; //Debut de la mission
  end_at: DateTime | null; //Fin de la 
  is_mandatory?: boolean; // True par défaut
  message_issue?: string; // Ou un enum FailureReasonCode spécifique au waypoint
}


export default class Order extends BaseModel { // Ou import { BaseModel } from '@adonisjs/lucid/orm' si tu n'as pas de base_model.ts custom
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare client_id: string

  @column()
  declare driver_id: string | null

  @column()
  declare pickup_address_id: string // Peut-être garder comme point de départ initial global ; a supprimé

  @column()
  declare delivery_address_id: string // Peut-être garder comme point de destination final global ; a supprimé

  @column()
  declare note_order: string | null

  @column()
  declare priority: OrderPriority

  @column()
  declare batch_id: string | null

  @column()
  declare remuneration: number

  @column()
  declare assignment_attempt_count: number

  @column()
  declare currency: string


  @column()
  declare calculation_engine: CalculationEngine | null // Moteur utilisé pour le calcul initial des legs

  @column()
  declare order_number_in_batch: number | null

  @column()
  declare client_fee: number

  // @column({ prepare: (value) => JSON.stringify(value ?? []) }) // Assurer que c'est un tableau
  // declare proof_of_pickup_media: string[]

  // @column({ prepare: (value) => JSON.stringify(value ?? []) }) // Assurer que c'est un tableau
  // declare proof_of_delivery_media: string[]

  @column.dateTime() // Garder si pertinent pour la demande initiale
  declare delivery_date_request: DateTime | null // Renommé pour clarté vs estimation

  @column.dateTime()
  declare delivery_date_estimation: DateTime // Estimation globale basée sur la somme des legs

  @column.dateTime()
  declare delivery_date: DateTime // Date de livraison

  @column()
  declare cancellation_reason_code: CancellationReasonCode | null

  @column()
  declare failure_reason_code: FailureReasonCode | null

  @column()
  declare offered_driver_id: string | null

  @column.dateTime()
  declare offer_expires_at: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true })
  declare updated_at: DateTime

  // NOUVEAU: Pour stocker un résumé ordonné des waypoints de la mission
  @column({
    prepare: (value: WaypointSummaryItem[] | null) => value ? JSON.stringify(value) : null,
    // consume: (value: string | null) => value ? JSON.parse(value) : null,
  })
  declare waypoints_summary: WaypointSummaryItem[] | null


  // --- RELATIONS ---
  @belongsTo(() => Driver, { foreignKey: 'offered_driver_id' })
  declare offered_driver: BelongsTo<typeof Driver>

  @belongsTo(() => Driver, { foreignKey: 'driver_id' })
  declare driver: BelongsTo<typeof Driver>

  @belongsTo(() => Client, { foreignKey: 'client_id' })
  declare client: BelongsTo<typeof Client>

  @belongsTo(() => Address, { foreignKey: 'pickup_address_id' }) // Adresse de départ globale
  declare pickup_address: BelongsTo<typeof Address>

  @belongsTo(() => Address, { foreignKey: 'delivery_address_id' }) // Adresse de fin globale
  declare delivery_address: BelongsTo<typeof Address>

  @hasMany(() => Package, { foreignKey: 'order_id' })
  declare packages: HasMany<typeof Package>

  @hasMany(() => OrderStatusLog, { foreignKey: 'order_id' })
  declare status_logs: HasMany<typeof OrderStatusLog>

  @hasMany(() => OrderTransaction, { foreignKey: 'order_id' })
  declare driver_payments: HasMany<typeof OrderTransaction>

  // NOUVELLE RELATION
  @hasMany(() => OrderRouteLeg, {
    foreignKey: 'order_id',
    onQuery: (query) => query.orderBy('leg_sequence', 'asc'), // Important pour les récupérer dans l'ordre
  })
  declare route_legs: HasMany<typeof OrderRouteLeg>
}