import { TicketStatus } from '#models/support_ticket'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'support_tickets'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table
        .string('company_id')
        .unsigned()
        .references('id')
        .inTable('companies')
        .onDelete('SET NULL')
        .nullable()
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
