import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'drivers'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table
        .string('user_id')
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
        .notNullable()
        .unique()
      table.string('latest_status').nullable()
      table.jsonb('mobile_money').defaultTo('[]')
      table.boolean('is_valid_driver').notNullable().defaultTo(false)
      table.float('average_rating').notNullable().defaultTo(0)
      table.specificType('current_location', 'geometry(Point, 4326)').nullable() // Position GPS
      table.timestamp('last_location_update').nullable() // Date de dernière mise à jour de la position
      table.string('fcm_token').nullable() // Token pour notifications push
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()

      table.jsonb('delivery_stats').defaultTo('[]') // [{status : string ; order_id : string ; timestamps : string[] }]
      table.index(['current_location'], 'idx_drivers_location', { indexType: 'gist' }) // Index GIST pour PostGIS
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
