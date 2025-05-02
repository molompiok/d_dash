import { PackageMentionWarning } from '#models/package'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'packages'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table.string('order_id').unsigned().references('id').inTable('orders').onDelete('CASCADE')
      table.string('name').notNullable()
      table.integer('quantity').notNullable()
      table.string('description').nullable()
      table.jsonb('dimensions').notNullable()
      table
        .enum('mention_warning', Object.values(PackageMentionWarning))
        .defaultTo(PackageMentionWarning.KEEP_COLD)
      table.jsonb('image_urls').defaultTo('[]')
      table.boolean('is_return').defaultTo('false')
      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
