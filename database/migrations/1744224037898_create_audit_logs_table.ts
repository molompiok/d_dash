import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'audit_logs'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table.string('user_id').unsigned().references('id').inTable('users')
      table.string('action').notNullable()
      table
        .string('order_id')
        .unsigned()
        .references('id')
        .inTable('orders')
        .onDelete('SET NULL')
        .nullable()
      table.json('details').nullable()
      table.timestamp('created_at').notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
