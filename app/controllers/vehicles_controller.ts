// app/controllers/vehicles_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import VehicleMake from '#models/vehicle_make'
import VehicleModel from '#models/vehicle_model'
import vine from '@vinejs/vine'

export default class VehiclesController {
  
  /**
   * Récupère les marques en fonction du type (car/motorbike)
   */
  public async getMakes({ request, response }: HttpContext) {
    const validator = vine.compile(
      vine.object({
        type: vine.enum(['car', 'motorbike']),
      })
    )
    
    // Correction : utiliser validator.validate() au lieu de request.validate()
    const { type } = await validator.validate(request.qs())
    
    const makes = await VehicleMake.query().where('type', type).orderBy('name', 'asc')
    return response.ok(makes)
  }

  /**
   * Récupère les modèles pour une marque donnée
   */
  public async getModels({ params, response }: HttpContext) {
    const makeId = params.makeId
    const models = await VehicleModel.query().where('vehicle_make_id', makeId).orderBy('name', 'asc')
    return response.ok(models)
  }
}