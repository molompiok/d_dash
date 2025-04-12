import { OrderTransactionStatus, OrderTransactionType } from '#models/order_transaction'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'order_transactions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table
        .uuid('driver_id')
        .unsigned()
        .references('id')
        .inTable('drivers')
        .onDelete('SET NULL')
        .nullable()
      table
        .uuid('order_id')
        .unsigned()
        .references('id')
        .inTable('orders')
        .onDelete('SET NULL')
        .nullable()
      table.string('currency').defaultTo('CFA')
      table
        .uuid('client_id')
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
      table.jsonb('history_status').defaultTo('[]')

      table.timestamp('payment_date').notNullable()
      table.timestamps(true, true)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
