// import { DateTime } from 'luxon'
// import { BaseModel, belongsTo, column } from '@adonisjs/lucid/orm'
// import * as relations from '@adonisjs/lucid/types/relations'
// import Driver from './driver.js'
// import Order from './order.js'
// import { Point } from 'geojson'

// export default class Assignment extends BaseModel {
//   @column({ isPrimary: true })
//   declare id: string

//   @column()
//   declare order_id: string

//   @column()
//   declare driver_id: string

//   // @column()
//   // declare status: AssignmentStatus

//   @column()
//   declare start_at: DateTime | null

//   @column()
//   declare end_at: DateTime | null

//   // @column()
//   // declare total_distance: number

//   // @column()
//   // declare crossing_point: { type: 'LineString'; coordinates: Point[] }

//   // @column()
//   // declare route_instructions: string[]

//   // @column()
//   // declare calculation_engine: CalculationEngine

//   @column()
//   declare history_status: string[]

//   @column.dateTime({ autoCreate: true })
//   declare created_at: DateTime

//   @column.dateTime({ autoCreate: true, autoUpdate: true })
//   declare updated_at: DateTime

//   @belongsTo(() => Order)
//   declare order: relations.BelongsTo<typeof Order>

//   @belongsTo(() => Driver)
//   declare driver: relations.BelongsTo<typeof Driver>
// }

// // export enum AssignmentStatus {
// //   PENDING = 'pending', // en attente de livreur
// //   ACCEPTED = 'accepted_by_driver',
// //   AT_PICKUP = 'at_pickup',
// //   EN_ROUTE_TO_DELIVERY = 'en_route_to_delivery',
// //   AT_DELIVERY_LOCATION = 'at_delivery_location',
// //   SUCCESS = 'success',
// //   FAILED = 'failed',
// //   CANCELLED = 'cancelled',
// // }
