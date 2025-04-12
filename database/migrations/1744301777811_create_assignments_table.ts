// import { AssignmentStatus, CalculationEngine } from '#models/assignment'
// import { BaseSchema } from '@adonisjs/lucid/schema'

// export default class extends BaseSchema {
//   protected tableName = 'assignments'

//   async up() {
//     this.schema.createTable(this.tableName, (table) => {
//       table.uuid('id').primary()

//       table.uuid('order_id').references('id').inTable('orders').onDelete('CASCADE')
//       table.uuid('driver_id').references('id').inTable('drivers').onDelete('CASCADE')
//       table.enum('status', Object.values(AssignmentStatus)).defaultTo(AssignmentStatus.PENDING)

//       // table.jsonb('route_instructions').nullable()
//       // table.specificType('crossing_point', 'geometry(LineString, 4326)').notNullable()
//       table.integer('total_distance')
//       table.jsonb('history_status').defaultTo('[]')

//       table.timestamp('start_at').nullable()
//       table.timestamp('end_at').nullable()

//       table.string('currency').defaultTo('CFA')
//       table.timestamp('created_at')
//       table.timestamp('updated_at')
//     })
//   }

//   async down() {
//     this.schema.dropTable(this.tableName)
//   }
// }
