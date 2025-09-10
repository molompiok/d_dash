// database/migrations/XXX_create_vehicle_models_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'vehicle_models'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table.string('name').notNullable()
      // Clé étrangère qui lie un modèle à une marque
      table.string('vehicle_make_id').references('id').inTable('vehicle_makes').onDelete('CASCADE')
      table.timestamps(true, true)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}