import { OrderTransactionStatus, OrderTransactionType, PaymentMethod } from '#models/order_transaction'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'order_transactions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table
        .string('driver_id')
        .unsigned()
        .references('id')
        .inTable('drivers')
        .onDelete('SET NULL')
        .nullable()
      table
        .string('order_id')
        .unsigned()
        .references('id')
        .inTable('orders')
        .onDelete('SET NULL')
        .nullable()
      table.string('currency').defaultTo('CFA')
      table.enum('payment_method', Object.values(PaymentMethod))
      table.jsonb('metadata').defaultTo('{}')
      table
        .string('client_id')
        .unsigned()
        .references('id')
        .inTable('clients')
        .onDelete('SET NULL')
        .nullable()
      table
        .enum('type', Object.values(OrderTransactionType))
        .defaultTo(OrderTransactionType.CLIENT_PAYMENT)
      table.integer('amount').notNullable() // En centimes
      table.string('transaction_reference').notNullable()

      table
        .enum('status', Object.values(OrderTransactionStatus))
        .defaultTo(OrderTransactionStatus.PENDING)
      table.jsonb('history_status').defaultTo('{}')

      table.timestamp('payment_date').notNullable()
      table.timestamps(true, true)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
