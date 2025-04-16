import { DocumentStatus, DocumentType } from '#models/user_document'
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class UserDocuments extends BaseSchema {
  protected tableName = 'user_documents'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()

      table.uuid('driver_id').references('id').inTable('drivers').onDelete('CASCADE')

      table.enum('type', Object.values(DocumentType)).notNullable() // ex: 'PRMIS DE CONDUIRE', 'CNI' , 'PASSPORT' , 'CONSULAR'
      table.jsonb('driving_license_images').defaultTo('[]') // ['licence.jpg']
      table.jsonb('identity_document_images').defaultTo('[]') // ['picture_Passport_recto.jpg', 'picture_Passport_verso.jpg']
      table.jsonb('photo').defaultTo('[]') // ['photo.jpg']
      table.enum('status', Object.values(DocumentStatus)).defaultTo(DocumentStatus.PENDING)
      table.string('rejection_reason').nullable()

      table.timestamp('submitted_at').defaultTo(this.now())
      table.timestamp('driving_license_expiry_date').nullable()
      table.timestamp('identity_document_expiry_date').nullable()
      table.timestamp('verified_at').nullable()

      table.timestamps(true)
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
