import { OrderTransactionStatus } from '#models/order_transaction'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'subscription_payments'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table
        .string('client_id')
        .unsigned()
        .references('id')
        .inTable('clients')
        .onDelete('SET NULL')
        .nullable()
      table
        .string('subscription_id')
        .unsigned()
        .references('id')
        .inTable('subscriptions')
        .onDelete('SET NULL')
        .nullable()
      table.integer('amount').notNullable()
      table
        .enum('status', Object.values(OrderTransactionStatus))
        .defaultTo(OrderTransactionStatus.PENDING)
      table.timestamp('payment_date').notNullable()
      table.timestamps(true, true)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
