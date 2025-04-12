import { RoleType } from '#models/user'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'users'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().notNullable()
      table.string('full_name').notNullable()
      table.boolean('is_active').notNullable().defaultTo(true)
      table.enum('role', Object.values(RoleType)).notNullable().defaultTo(RoleType.CLIENT)
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
