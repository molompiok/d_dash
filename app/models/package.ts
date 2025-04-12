import { DateTime } from 'luxon'
import { BaseModel, belongsTo, column } from '@adonisjs/lucid/orm'
import Order from './order.js'
import * as relations from '@adonisjs/lucid/types/relations'

export default class Package extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare order_id: string

  @column()
  declare name: string

  @column()
  declare description: string | null

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare dimensions: { depth_cm: number; width_cm: number; height_cm: number; weight_g: number }

  @column()
  declare mention_warning: PackageMentionWarning

  @column()
  declare quantity: number

  @column({
    prepare: (value) => JSON.stringify(value),
  })
  declare image_urls: string[]

  @column()
  declare is_return: boolean

  @column.dateTime({ autoCreate: true })
  declare created_at: DateTime

  @column.dateTime({ autoUpdate: true }) // Seulement autoUpdate
  declare updated_at: DateTime | null

  @belongsTo(() => Order)
  declare order: relations.BelongsTo<typeof Order>
}

export enum PackageMentionWarning {
  KEEP_COLD = 'keep_cold',
  KEEP_WARM = 'keep_warm',
  FRAGILE = 'fragile',
}
