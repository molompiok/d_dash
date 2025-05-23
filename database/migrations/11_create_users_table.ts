import { RoleType } from '#models/user'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'users'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id', 36).primary().notNullable()
      table.string('full_name').notNullable()
      table.string('google_id').nullable()
      table.string('facebook_id').nullable()
      // table.enum('role', Object.values(RoleType)).notNullable().defaultTo(RoleType.CLIENT)
      table.string('email', 254).notNullable().unique()
      table.string('password').notNullable()
      table.jsonb('photo').defaultTo('[]')
      table.jsonb('phone').defaultTo('[]')

      table.timestamps(true, true)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
