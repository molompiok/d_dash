import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import DriverLocationLog from '#models/driver_location_log'
import vine from '@vinejs/vine'
import db from '@adonisjs/lucid/services/db'
import Driver from '#models/driver'
import Ws from '#services/ws_service'
import redis from '@adonisjs/redis/services/main'
import DriverVehicle, { VehicleStatus } from '#models/driver_vehicle'
import { createFiles } from '#services/media/CreateFiles'
import logger from '@adonisjs/core/services/logger'

export default class DriversController {


    updateLocationValidator = vine.compile(
        vine.object({
          // On attend un tableau 'locations' qui ne doit pas être vide
          locations: vine.array(
            vine.object({
              latitude: vine.number().min(-90).max(90),
              longitude: vine.number().min(-180).max(180),
              timestamp_ms: vine.number(),
              accuracy: vine.number().optional(),
              speed: vine.number().optional(),
              heading: vine.number().optional(),
              batteryLevel: vine.number().optional(),
              isMoving: vine.boolean().optional(),
            })
          ).minLength(1)
        })
      )
     /**
   * Reçoit un lot de mises à jour de localisation d'un livreur.
   * Stocke l'historique et met à jour la dernière position connue du livreur.
   */
  public async batchUpdateLocation({ request, auth, response }: HttpContext) {
    // 1. Authentifier l'utilisateur et s'assurer qu'il est un livreur
    const user = auth.user

    // CORRECTION : Si aucun utilisateur n'est attaché à la requête, c'est une erreur d'authentification.
    if (!user) {
      // On retourne une erreur 401 claire, ce qui est la bonne pratique.
      return response.unauthorized({ error: 'Accès non autorisé. Token manquant ou invalide.' })
    }

    // A partir d'ici, on sait que 'user' existe.
    await user.load('driver')
    const driver = user.driver

    if (!driver) {
      return response.unauthorized({ error: 'Cet utilisateur authentifié n\'est pas un livreur.' })
    }
    // 2. Valider les données entrantes
    const payload = await request.validateUsing(this.updateLocationValidator)

    // 3. Préparer les données pour une insertion en masse (très performant)
    const locationLogsData = payload.locations.map(loc => ({
      driver_id: driver.id,
      location: {
        type: 'Point' as const,
        coordinates: [loc.longitude, loc.latitude] as [number, number],
      },
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      batteryLevel: loc.batteryLevel,
      isMoving: loc.isMoving,
      // Convertit le timestamp millisecondes en objet DateTime
      timestamp: DateTime.fromMillis(loc.timestamp_ms),
    }))

    // 4. Trouver la position la plus récente dans le lot reçu
    const latestLocation = payload.locations.reduce((latest, current) => {
      return current.timestamp_ms > latest.timestamp_ms ? current : latest
    })

    // 5. Utiliser une transaction pour garantir que tout est enregistré correctement
    try {
      await db.transaction(async (trx) => {
        // 5a. Insérer tous les journaux de localisation en une seule requête
        await DriverLocationLog.createMany(locationLogsData as Partial<DriverLocationLog>[], { client: trx })

        // 5b. Mettre à jour la fiche principale du livreur avec la dernière position
        const driverToUpdate = await Driver.findOrFail(driver.id, { client: trx })
        
        driverToUpdate.current_location = {
          type: 'Point',
          // CORRECTION : On applique le même cast de tuple ici
          coordinates: [latestLocation.longitude, latestLocation.latitude] as [number, number],
        }
        await driverToUpdate.save()
      })
    } catch (error) {
      console.error('Échec du traitement du lot de localisations :', error)
      return response.internalServerError({ error: 'Échec de la sauvegarde des données.' })
    }

    if (Ws.io) {
        const dataToSend = {
          lat: latestLocation.latitude,
          lon: latestLocation.longitude,
          timestamp: Math.floor(latestLocation.timestamp_ms / 1000)
        }
        
        // Envoyer l'événement uniquement au livreur concerné via sa "room" privée
        Ws.io.to(`driver_${driver.id}`).emit('location_update', dataToSend)
        console.log(`🚀 Événement 'location_update' émis pour le livreur ${driver.id}`)
      }

    // 7. Répondre avec 204 No Content, comme attendu par votre code front-end.
    return response.noContent()
  }

  public async recordHeartbeat({ auth, response }: HttpContext) {
    const driver = auth.user!.driver // On peut assumer que le driver existe grâce à la logique d'auth

    // Si le livreur n'est pas trouvé (sécurité supplémentaire), on ne fait rien.
    if (!driver) {
      return response.unauthorized()
    }

    const heartbeatKey = `driver:heartbeat:${driver.id}`
    const fiveMinutesInSeconds = 300

    // Met à jour la clé Redis avec le timestamp actuel et réinitialise son temps d'expiration à 5 minutes.
    // C'est une opération atomique et très rapide.
    await redis.set(heartbeatKey, Math.floor(Date.now() / 1000), 'EX', fiveMinutesInSeconds)

    // On répond avec 204 No Content, car le client n'a pas besoin de réponse, juste d'une confirmation de succès.
    return response.noContent()
  }

  public async registerVehicle({ request, auth, response }: HttpContext) {
    const user = auth.user!
    await user.load('driver')
    const driver = user.driver
    if (!driver) {
      return response.unauthorized()
    }

   const registerVehicleValidator = vine.compile(
      vine.object({
        type: vine.enum(['car', 'motorbike']),
        makeId: vine.string(), // Valide que c'est bien un CUID
        modelId: vine.string(),
        color: vine.string().minLength(3),
        manufactureYear: vine.number().min(1980).max(new Date().getFullYear()),
        licensePlate: vine.string().minLength(3).maxLength(10).toUpperCase(),
      })
    )

    // 1. Valider les données du formulaire
    const payload = await request.validateUsing(registerVehicleValidator)

    // 2. Transformer les noms de clés pour correspondre au modèle (ex: makeId -> vehicle_make_id)
    const vehicleData = {
      type: payload.type,
      vehicle_make_id: payload.makeId,
      vehicle_model_id: payload.modelId,
      color: payload.color,
      manufacture_year: payload.manufactureYear,
      license_plate: payload.licensePlate,
      driver_id: driver.id,
      status: VehicleStatus.PENDING, // Toujours en attente de validation à la création/mise à jour
    }

    try {
      // 3. Utiliser updateOrCreate pour créer le véhicule s'il n'existe pas,
      // ou le mettre à jour s'il existe déjà pour ce livreur.
      const vehicle = await DriverVehicle.updateOrCreate(
        { driver_id: driver.id }, // Clé de recherche
        vehicleData // Données à insérer ou mettre à jour
      )
      
      // On recharge les relations pour renvoyer une réponse complète si besoin
      await vehicle.load('make')
      await vehicle.load('model')

      return response.created(vehicle)

    } catch (error) {
      // Gérer le cas où la plaque d'immatriculation existe déjà pour un autre livreur
      if (error.code === '23505') { // Code d'erreur PostgreSQL pour violation d'unicité
        return response.conflict({ message: 'Cette plaque d\'immatriculation est déjà enregistrée.'})
      }
      return response.internalServerError({ message: 'Erreur lors de l\'enregistrement du véhicule.', error })
    }
  }

  public async uploadVehiclePhotos({ request, auth, response }: HttpContext) {
    const user = auth.user!
    await user.load('driver')
    const driver = user.driver
    if (!driver) {
      return response.unauthorized()
    }

    // 1. Vérifier que le livreur a un véhicule auquel associer les photos
    const vehicle = await DriverVehicle.findBy('driver_id', driver.id)
    if (!vehicle) {
      return response.notFound({ message: 'Aucun véhicule trouvé pour ce livreur. Veuillez d\'abord enregistrer les détails du véhicule.' })
    }

    // --- Traitement des fichiers avec VOTRE logique ---
    let newImageUrls: string[] = [];
    try {
      // 2. Votre frontend nomme les fichiers "vehicle_photos_0", "vehicle_photos_1", etc.
      newImageUrls = await createFiles({
        request: request,
        table_id: vehicle.id, // On lie les photos à l'ID du véhicule
        table_name: 'driver_vehicles',
        column_name: 'vehicle_photos', // Le préfixe utilisé par le frontend
        options: {
          maxSize: 10 * 1024 * 1024, // 10MB
          extname: ['jpg', 'jpeg', 'png', 'webp'],
          compress: 'img',
          throwError: true,
        }
      })

      if (newImageUrls.length === 0) {
        return response.badRequest({ error: 'Aucune photo valide n\'a été traitée.' })
      }
      
    } catch (error) {
      logger.error(error, `Erreur lors du traitement des photos pour le véhicule ${vehicle.id}`)
      return response.internalServerError({ message: 'Erreur lors du traitement des photos.', error: error.message })
    }

    // --- Sauvegarde en base de données ---
    try {
      // 3. Mettre à jour le véhicule avec les nouvelles URLs
      // On fusionne les nouvelles URLs avec les anciennes si on veut permettre des ajouts partiels
      // Ou on remplace simplement, ce qui est souvent plus simple.
      vehicle.image_urls = newImageUrls
      
      // On pourrait aussi remettre le statut en 'pending' si l'ajout de photos nécessite une re-vérification
      // vehicle.status = 'pending'

      await vehicle.save()

      logger.info({ vehicleId: vehicle.id, urls: newImageUrls }, `Photos pour le véhicule sauvegardées avec succès.`)
      return response.ok({ message: "Photos du véhicule uploadées avec succès." })

    } catch (error) {
      logger.error(error, `Erreur de sauvegarde des URLs de photos pour le véhicule ${vehicle.id}`)
      return response.internalServerError({ message: 'Erreur lors de la sauvegarde des photos.', error: error.message })
    }
  }
}