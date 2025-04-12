import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'subscriptions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table.string('name').notNullable().unique() // premium_pro_max_lol
      table.integer('order_limit').notNullable() // jour
      table.integer('price').notNullable()
      table.string('currency').defaultTo('CFA')
      table.string('description').notNullable()
      table.timestamps(true, true)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
