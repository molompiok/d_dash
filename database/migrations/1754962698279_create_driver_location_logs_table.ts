import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'driver_location_logs'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table.string('driver_id').references('id').inTable('drivers').onDelete('CASCADE').notNullable()

      // Utilise le type GEOGRAPHY pour des calculs de distance précis.
      // Le SRID 4326 est la norme pour les coordonnées GPS (latitude/longitude).
      table.specificType('location', 'geometry(Point, 4326)').notNullable()

      table.float('accuracy').nullable()
      table.float('speed').nullable()
      table.float('heading').nullable()
      table.float('battery_level').nullable()
      table.boolean('is_moving').nullable()
      table.timestamp('timestamp', { useTz: true }).notNullable() // Le timestamp de la position réelle

      table.timestamp('created_at', { useTz: true }) // Le timestamp de l'enregistrement en BDD
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}