// database/migrations/xxxx_create_driver_availability_rules_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'driver_availability_rules'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()')) // ou .defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery) dans Adonis v6

      table.uuid('driver_id').references('id').inTable('drivers').onDelete('CASCADE').notNullable()
      table.integer('day_of_week').notNullable().checkBetween([0, 6]) // 0=Dim, 1=Lun...6=Sam
      table.time('start_time').notNullable() // Stocker en UTC dans l'app
      table.time('end_time').notNullable() // Stocker en UTC dans l'app
      table.boolean('is_active').notNullable().defaultTo(true)

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()

      // Index pour optimiser les recherches de disponibilité
      table.index(['driver_id'], 'idx_availability_rules_driver_id')
      table.index(['driver_id', 'day_of_week'], 'idx_availability_rules_driver_day')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
