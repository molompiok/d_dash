// database/migrations/XXX_create_user_documents_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'
import { DocumentStatus, DocumentType } from '#models/user_document' // On importera ces enums depuis le modèle

export default class extends BaseSchema {
  protected tableName = 'user_documents'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id').primary()
      table.string('driver_id').references('id').inTable('drivers').onDelete('CASCADE').notNullable()
      
      // Le type de document (CNI, PASSPORT, etc.)
      table.enum('type', Object.values(DocumentType)).notNullable()

      // Le statut du document (en attente, approuvé, rejeté)
      table.enum('status', Object.values(DocumentStatus)).defaultTo(DocumentStatus.PENDING).notNullable()
      
      // Un champ JSON pour stocker les URLs des fichiers
      table.jsonb('file_urls').notNullable().defaultTo('[]')

      // Un champ JSON pour les métadonnées (ex: numéro de permis, type de CNI)
      table.jsonb('metadata').nullable()

      table.text('rejection_reason').nullable()
      table.timestamp('verified_at', { useTz: true }).nullable()
      table.timestamp('submitted_at', { useTz: true }).nullable()
      
      table.timestamps(true, true)
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}