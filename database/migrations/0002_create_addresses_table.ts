// database/migrations/xxxx_addresses.ts

import { BaseSchema } from '@adonisjs/lucid/schema'

export default class Addresses extends BaseSchema {
  protected tableName = 'addresses'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()

      table.string('street_address').notNullable()
      table.string('city').notNullable()
      table.string('postal_code').notNullable()
      table.string('municipality').nullable() //ex : yopougon
      table.string('country').notNullable()

      table.specificType('coordinates', 'geometry(Point, 4326)').notNullable()
      table.text('address_details').nullable() // étage, code porte, etc.
      table.boolean('is_commercial').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // Ajout d’un index spatial GIST pour les recherches géographiques
    this.schema.raw(
      `CREATE INDEX addresses_coordinates_gist ON ${this.tableName} USING GIST (coordinates)`
    )
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
