// database/migrations/xxxx_driver_vehicles.ts
import { VehicleStatus, VehicleType } from '#models/driver_vehicle'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class DriverVehicles extends BaseSchema {
  protected tableName = 'driver_vehicles'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()

      table.string('driver_id').notNullable().references('id').inTable('drivers').onDelete('CASCADE')

      table
        .enum('type', Object.values(VehicleType))
        .defaultTo(VehicleType.Motorcycle)
        .notNullable()

      table.string('license_plate').unique().nullable()
      table.string('model').nullable()
      
      table.string('color').nullable()
      table.jsonb('vehicle_image').defaultTo('[]')
      table.jsonb('license_image').defaultTo('[]')
      table.jsonb('vehicle_document').defaultTo('[]')
      table.boolean('has_refrigeration').defaultTo(false)
      table
        .enum('status', Object.values(VehicleStatus))
        .notNullable()
        .defaultTo(VehicleStatus.PENDING)
      table.timestamp('insurance_expiry_date').nullable()

      table.float('max_weight_kg').notNullable().defaultTo(0)
      table.float('max_volume_m3').notNullable().defaultTo(0)

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })
  }

  public async down() {
    this.schema.raw('DROP TYPE IF EXISTS vehicle_type CASCADE') // nettoyage enum Postgres
    this.schema.dropTable(this.tableName)
  }
}
