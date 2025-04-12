import {
  CalculationEngine,
  CancellationReasonCode,
  FailureReasonCode,
  OrderStatus,
} from '#models/order'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'orders'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table.uuid('client_id').references('id').inTable('clients').onDelete('CASCADE')
      table
        .enum('priority', Object.values(OrderPriority))
        .defaultTo(OrderPriority.MEDIUM)
        .notNullable()
      table.uuid('driver_id').references('id').inTable('drivers').onDelete('SET NULL').nullable()
      table.text('note_order').nullable()
      table.uuid('batch_id').nullable()
      table.string('confirmation_code').nullable()
      table.integer('remuneration').defaultTo(0).checkPositive()
      table.jsonb('route_instructions').nullable()
      table.specificType('route_geometry', 'geometry(LineString, 4326)').notNullable()
      table.integer('route_distance_meters').notNullable()
      table.string('currency').defaultTo('CFA')
      table.jsonb('proof_of_pickup_media').defaultTo('[]')
      table.jsonb('proof_of_delivery_media').defaultTo('[]')
      table.integer('order_number_in_batch').nullable()
      table
        .enum('calculation_engine', Object.values(CalculationEngine))
        .defaultTo(CalculationEngine.VALHALLA)

      table.enum('cancellation_reason_code', Object.values(CancellationReasonCode)).nullable()
      table.enum('failure_reason_code', Object.values(FailureReasonCode)).nullable()
      table.integer('client_fee').unsigned().notNullable()
      table
        .uuid('pickup_address_id')
        .references('id')
        .inTable('addresses')
        .notNullable()
        .onDelete('SET NULL')
      table
        .uuid('delivery_address_id')
        .references('id')
        .inTable('addresses')
        .notNullable()
        .onDelete('SET NULL')
      // table.enum('status', Object.values(OrderStatus)).defaultTo(OrderStatus.PENDING)
      table.timestamp('delivery_date', { useTz: true }).notNullable()
      table.timestamp('delivery_date_estimation', { useTz: true }).notNullable()
      table.timestamps(true, true)
      table.index(['delivery_address_id'], 'idx_orders_delivery_address_id')
      table.index(['driver_id'], 'idx_orders_driver_id')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}

export enum OrderPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}
