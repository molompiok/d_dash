import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'clients'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE')

      table.string('api_key').unique().notNullable()
      table.string('company_name').nullable()
      table
        .uuid('subscription_id')
        .unsigned()
        .references('id')
        .inTable('subscriptions')
        .onDelete('SET NULL')
      table.integer('order_count').defaultTo(0)
      table.timestamps(true, true)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
