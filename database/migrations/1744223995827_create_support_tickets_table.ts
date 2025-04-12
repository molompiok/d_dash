import { TicketStatus } from '#models/support_ticket'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'support_tickets'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table
        .uuid('client_id')
        .unsigned()
        .references('id')
        .inTable('clients')
        .onDelete('SET NULL')
        .nullable()
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
      table.string('subject').notNullable()
      table.text('description').notNullable()
      table.enum('status', Object.values(TicketStatus)).defaultTo(TicketStatus.OPEN)
      table.text('resolve_message')
      table.timestamps(true, true)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
