import { NotificationChannel, NotificationType } from '#models/notification'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'notifications'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table
        .uuid('recipient_user_id')
        .unsigned()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table
        .uuid('order_id')
        .unsigned()
        .references('id')
        .inTable('orders')
        .onDelete('SET NULL')
        .nullable()
      table.enum('type', Object.values(NotificationType)).notNullable()
      table.enum('channel', Object.values(NotificationChannel)).notNullable()
      table.text('message').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('read_at').nullable()
      table.timestamp('sent_at').nullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
