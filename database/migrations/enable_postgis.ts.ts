import { BaseSchema } from '@adonisjs/lucid/schema'

export default class EnablePostgis extends BaseSchema {
  async up() {
    await this.db.rawQuery('CREATE EXTENSION IF NOT EXISTS postgis;')
  }

  async down() {
    await this.db.rawQuery('DROP EXTENSION IF EXISTS postgis;')
  }
}
