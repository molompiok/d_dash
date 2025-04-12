// database/migrations/xxxx_rating_drivers.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class RatingDrivers extends BaseSchema {
  protected tableName = 'rating_drivers'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()

      table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE')

      table.uuid('driver_id').notNullable().references('id').inTable('drivers').onDelete('CASCADE')

      table.uuid('rater_user_id').nullable().references('id').inTable('users').onDelete('SET NULL')

      table.integer('rating_score').notNullable().checkBetween([1, 5]) // Adonis-style check

      table.text('comment').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()

      // Contrainte unique : 1 évaluation par livraison et livreur
      table.unique(['order_id', 'driver_id'])
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
