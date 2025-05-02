// database/migrations/xxxx_create_driver_availability_exceptions_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'driver_availability_exceptions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()

      table.string('driver_id').references('id').inTable('drivers').onDelete('CASCADE').notNullable()
      table.date('exception_date').notNullable()
      table.boolean('is_unavailable_all_day').notNullable().defaultTo(true)
      table.time('unavailable_start_time').nullable() // Si pas toute la journée
      table.time('unavailable_end_time').nullable() // Si pas toute la journée
      table.text('reason').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).nullable()

      // Index pour retrouver rapidement les exceptions d'un livreur pour une date donnée
      table.index(['driver_id', 'exception_date'], 'idx_availability_exceptions_driver_date')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
