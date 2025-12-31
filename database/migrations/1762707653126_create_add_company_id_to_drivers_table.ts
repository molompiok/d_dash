import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'drivers'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table
        .string('company_id')
        .references('id')
        .inTable('companies')
        .onDelete('SET NULL')
        .nullable()
        .after('user_id')
      
      // Index pour améliorer les performances des requêtes par client
      table.index(['company_id'], 'idx_drivers_company_id')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropIndex('idx_drivers_company_id')
      table.dropColumn('company_id')
    })
  }
}