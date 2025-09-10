// database/seeders/vehicle_seeder.ts
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import VehicleMake from '#models/vehicle_make'
import VehicleModel from '#models/vehicle_model'

export default class extends BaseSeeder {
  public async run() {
    // Créer des marques de voitures
    const toyota = await VehicleMake.create({ name: 'Toyota', type: 'car' })
    const honda = await VehicleMake.create({ name: 'Honda', type: 'car' })

    // Créer des modèles pour Toyota
    await VehicleModel.createMany([
      { name: 'Yaris', vehicle_make_id: toyota.id },
      { name: 'Corolla', vehicle_make_id: toyota.id },
      { name: 'RAV4', vehicle_make_id: toyota.id },
    ])

    // Créer des modèles pour Honda
    await VehicleModel.createMany([
      { name: 'Civic', vehicle_make_id: honda.id },
      { name: 'Accord', vehicle_make_id: honda.id },
    ])

    // Créer des marques de motos
    const yamaha = await VehicleMake.create({ name: 'Yamaha', type: 'motorbike' })
    const kawasaki = await VehicleMake.create({ name: 'Kawasaki', type: 'motorbike' })

    // Créer des modèles pour Yamaha
    await VehicleModel.createMany([
        { name: 'MT-07', vehicle_make_id: yamaha.id },
        { name: 'TMAX', vehicle_make_id: yamaha.id },
    ])
    
    // Créer des modèles pour Kawasaki
    await VehicleModel.createMany([
        { name: 'Ninja 400', vehicle_make_id: kawasaki.id },
        { name: 'Z900', vehicle_make_id: kawasaki.id },
    ])
  }
}