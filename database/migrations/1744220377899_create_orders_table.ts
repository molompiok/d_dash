import {
  CalculationEngine,
  CancellationReasonCode,
  FailureReasonCode,
  OrderPriority,
} from '#models/order'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'orders'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table.string('company_id').references('id').inTable('companies').onDelete('CASCADE')
      table
        .enum('priority', Object.values(OrderPriority))
        .defaultTo(OrderPriority.MEDIUM)
        .notNullable()
      table.string('driver_id').references('id').inTable('drivers').onDelete('SET NULL').nullable()
      table.text('note_order').nullable()
      table.string('batch_id').nullable()
      table.string('confirmation_delivery_code').nullable()
      table.string('confirmation_pickup_code').nullable()
      table.integer('remuneration').defaultTo(0).checkPositive()
      // table.jsonb('route_instructions').nullable()
      // table.integer('route_duration_seconds').notNullable()
      // table.specificType('route_geometry', 'geometry(LineString, 4326)').notNullable()
      // table.integer('route_distance_meters').notNullable()
      table.string('currency').defaultTo('CFA')
      table.integer('assignment_attempt_count').defaultTo(0)
      table.jsonb('proof_of_pickup_media').defaultTo('[]')
      table.jsonb('proof_of_delivery_media').defaultTo('[]')
      table.integer('order_number_in_batch').nullable()

      table
        .enum('calculation_engine', Object.values(CalculationEngine))
        .defaultTo(CalculationEngine.VALHALLA)

      table.enum('cancellation_reason_code', Object.values(CancellationReasonCode)).nullable()
      table.enum('failure_reason_code', Object.values(FailureReasonCode)).nullable()
      table.integer('client_fee').unsigned().notNullable()
      table.jsonb('waypoints_summary').nullable()
      table
        .string('pickup_address_id')
        .references('id')
        .inTable('addresses')
        .notNullable()
        .onDelete('SET NULL')
      table
        .string('delivery_address_id')
        .references('id')
        .inTable('addresses')
        .notNullable()
        .onDelete('SET NULL')
      // table.enum('status', Object.values(OrderStatus)).defaultTo(OrderStatus.PENDING)
      table.timestamp('delivery_date', { useTz: true }).notNullable()
      table.timestamp('delivery_date_estimation', { useTz: true }).nullable().comment('Estimation globale basée sur la somme des legs')
      // Ajoute la colonne pour savoir à qui l'offre est faite
      table
        .string('offered_driver_id')
        .nullable()
        .references('id')
        .inTable('drivers')
        .onDelete('SET NULL')
      // Ajoute la colonne pour le timestamp d'expiration de l'offre
      table.timestamp('offer_expires_at', { useTz: true }).nullable() // Important: Avec fuseau horaire
      // Ajoute un index pour rechercher rapidement les commandes offertes à un driver
      table.index(['offered_driver_id'], 'orders_offered_driver_id_index')
      table.timestamps(true, true)
      table.index(['delivery_address_id'], 'idx_orders_delivery_address_id')
      table.index(['driver_id'], 'idx_orders_driver_id')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
