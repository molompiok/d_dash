import { DriverStatus } from '#models/drivers_status'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'driver_statuses'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().notNullable()
      table.uuid('driver_id').notNullable().references('id').inTable('drivers').onDelete('CASCADE')
      table
        .enum('status', Object.values(DriverStatus))
        .notNullable()
        .defaultTo(DriverStatus.INACTIVE)

      table.integer('assignments_in_progress_count').notNullable().defaultTo(0)
      table.timestamp('changed_at').notNullable() // Date de début du statut
      table.jsonb('metadata').nullable() // Informations supplémentaires (par ex., raison d'une pause)
      //chaque changement de statut met a jour la metadata

      // Index pour optimiser les recherches
      table.index(['driver_id', 'status'], 'idx_driver_statuses_driver_status')
      table.index(['changed_at'], 'idx_driver_statuses_changed_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
