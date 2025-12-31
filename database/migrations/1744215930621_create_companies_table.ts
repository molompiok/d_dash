import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'companies'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table.string('user_id').references('id').inTable('users').onDelete('CASCADE')
      table.boolean('is_valid_company').notNullable().defaultTo(false)
      table.string('fcm_token').nullable()
      table.string('api_key').unique().notNullable()
      table.string('company_name').nullable()
      table
        .string('subscription_id')
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
