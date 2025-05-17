// database/migrations/XXXXXXXXXXXXXX_create_order_route_legs_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'order_route_legs'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary() // ou .uuid('id').primary().defaultTo(this.raw('uuid_generate_v4()')) si tu préfères UUID
      table.string('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE')
      table.integer('leg_sequence').notNullable()

      // Optionnel: FK vers adresses pour début/fin de leg si ce sont des waypoints connus
      table.string('start_address_id').nullable().references('id').inTable('addresses').onDelete('SET NULL')
      table.string('end_address_id').nullable().references('id').inTable('addresses').onDelete('SET NULL')

      // Coordonnées de début/fin brutes (pour le 1er leg depuis le driver, ou si pas d'adresse formelle)
      // Utiliser specificType pour GEOMETRY avec PostGIS
      table.specificType('start_coordinates', 'GEOMETRY(Point, 4326)').nullable()
      table.specificType('end_coordinates', 'GEOMETRY(Point, 4326)').nullable()


      table.specificType('geometry', 'GEOMETRY(LineString, 4326)').nullable() // Stocke la polyline du leg
      table.integer('duration_seconds').nullable()
      table.integer('distance_meters').nullable()
      table.jsonb('maneuvers').nullable() // Stocke le tableau des manœuvres Valhalla
      table.jsonb('raw_valhalla_leg_data').nullable() // Pour le débug ou infos complètes

      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())

      table.index(['order_id', 'leg_sequence'], 'order_leg_sequence_idx') // Index utile
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}