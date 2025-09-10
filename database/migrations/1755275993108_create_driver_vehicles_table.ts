// database/migrations/XXX_create_driver_vehicles_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'driver_vehicles'
  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      
      // Clés étrangères
      table.string('driver_id').references('id').inTable('drivers').onDelete('CASCADE').notNullable().unique()
      table.string('vehicle_make_id').references('id').inTable('vehicle_makes').onDelete('SET NULL')
      table.string('vehicle_model_id').references('id').inTable('vehicle_models').onDelete('SET NULL')
  
      // Champs du formulaire
      table.enum('type', ['car', 'motorbike']).notNullable()
      table.string('color').notNullable()
      table.integer('manufacture_year').notNullable()
      table.string('license_plate').notNullable().unique()
      
      // Statut de validation
      table.enum('status', ['pending', 'active', 'rejected']).defaultTo('pending').notNullable()
      
      // Images après status
      table.jsonb('image_urls').notNullable().defaultTo('[]')
      
      table.timestamps(true, true)
    })
  }
  async down() {
    this.schema.dropTable(this.tableName)
  }
}