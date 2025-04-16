import { OrderStatus } from '#models/order'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'order_status_logs'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table.uuid('order_id').unsigned().references('id').inTable('orders').onDelete('CASCADE')
      table.uuid('changed_by_user_id').references('id').inTable('users').onDelete('CASCADE')
      table.enum('status', Object.values(OrderStatus)).notNullable()
      table.timestamp('changed_at').notNullable()
      table.jsonb('metadata').nullable()
      table.specificType('current_location', 'geometry(Point, 4326)').notNullable()
      table.timestamp('created_at').notNullable()
      this.schema.raw(
        `CREATE INDEX current_location_gist ON ${this.tableName} USING GIST (current_location)`
      )
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
