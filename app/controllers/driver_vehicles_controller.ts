// import type { HttpContext } from '@adonisjs/core/http'
// import { inject } from '@adonisjs/core'
// import db from '@adonisjs/lucid/services/db' // Probablement pas nécessaire pour le CRUD simple ici
// import DriverVehicle, { VehicleType } from '#models/driver_vehicle'
// import { VehicleStatus } from '#models/driver_vehicle'
// import logger from '@adonisjs/core/services/logger'
// import { cuid } from '@adonisjs/core/helpers'
// import vine from '@vinejs/vine'
// import { DateTime } from 'luxon'
// import { updateFiles } from '#services/media/UpdateFiles'
// import { deleteFiles } from '#services/media/DeleteFiles'
// import Driver from '#models/driver'
// import { Logger } from '@adonisjs/core/logger'
// import { createFiles } from '#services/media/CreateFiles'
// import { NotificationHelper } from '#services/notification_helper'
// import redis_helper from '#services/redis_helper'
// import { NotificationType } from '#models/notification'

// const expirationDateRule = vine.string().transform((value: string) => {
//   if (!value.match(/^\d{4}-\d{2}-\d{2}$/)) {
//     throw new Error("La date d'expiration doit être au format YYYY-MM-DD")
//   }
//   const date = DateTime.fromISO(value, { zone: 'utc' })

//   if (!date.isValid) {
//     throw new Error('La date est invalide.')
//   }

//   const today = DateTime.utc().startOf('day')
//   const maxFutureDate = today.plus({ years: 20 })

//   if (date <= today) {
//     throw new Error("La date d'expiration doit être dans le futur.")
//   }

//   if (date > maxFutureDate) {
//     throw new Error("La date d'expiration est trop lointaine.")
//   }

//   return value
// })

// const listVehiclesQueryValidator = vine.compile(
//   vine.object({
//     status: vine.enum(VehicleStatus).optional(), // Filtre optionnel par statut
//     driver_id: vine.string().optional(), // Filtre optionnel par ID de driver (si besoin de voir les véhicules d'un driver spécifique)
//     license_plate: vine.string().trim().optional(), // Filtre optionnel par plaque
//     page: vine.number().min(1).optional(), // Pour la pagination
//     perPage: vine.number().min(1).max(100).optional(), // Pour la pagination (limite max)
//   })
// )

// export const driverVehicleValidator = vine.compile(
//   vine.object({
//     type: vine.enum(VehicleType), // Type de véhicule obligatoire depuis l'enum
//     license_plate: vine.string().trim().minLength(3).maxLength(15).optional().nullable(), // Plaque optionnelle
//     insurance_expiry_date: expirationDateRule, // Date ou null

//     has_refrigeration: vine.boolean().optional(), // Par défaut à false si non fourni ?

//     status: vine.enum(VehicleStatus).optional(), // Statut optionnel (probablement défaut ACTIVE si création?)

//     model: vine.string().trim().optional().nullable(),
//     color: vine.string().trim().optional().nullable(),

//     // Capacités - nombres positifs
//     max_weight_kg: vine.number().positive(),
//     max_volume_m3: vine.number().positive(),

//     // Gestion des images (similaire à UserDocument/Profile)
//     // TODO Rajouter image permis de conduire ; images document licence
//     vehicle_image: vine
//       .array(
//         vine.file({
//           // Attends un tableau de fichiers
//           size: '15mb',
//           extnames: ['jpg', 'jpeg', 'png', 'webp'],
//         })
//       )
//       .optional(), // Le champ lui-même est optionnel

//     _vehicleImageNewPseudoUrls: vine.string().optional(), // Champ meta si besoin pour updateFiles
//   })
// )
// const updateVehicleStatusValidator = vine.compile(
//   vine.object({
//     status: vine.enum(VehicleStatus),
//   })
// )

// @inject()
// export default class DriverVehicleController {
//   /**
//    * Liste tous les véhicules du driver connecté.
//    * GET /driver/vehicles
//    * Nécessite: Auth, Rôle Driver
//    */
//   async index({ auth, response }: HttpContext) {
//     logger.info('Liste véhicules du driver')
//     await auth.check()
//     const user = await auth.authenticate() // L'user est un Driver grâce au middleware acl

//     const driver = await Driver.findBy('user_id', user.id)

//     if (!driver) {
//       logger.error({ userId: user.id }, 'Aucun driver trouvé pour ce user')
//       return response.unauthorized({ message: 'Aucun driver trouvé pour ce user.' })
//     }

//     try {
//       // Récupère les véhicules liés à l'ID du driver (qui est le même que user.id)
//       const vehicles = await DriverVehicle.query().where('driver_id', driver.id)

//       logger.info({ vehicles }, 'Véhicules du driver')

//       if (!vehicles) {
//         return response.notFound({ message: 'Aucun véhicule trouvé pour ce driver.' })
//       }

//       return response.ok(vehicles[0])
//     } catch (error) {
//       logger.error({ err: error, driverId: user.id }, 'Erreur récupération véhicules du driver')
//       return response.internalServerError({
//         message: 'Erreur lors de la récupération des véhicules.',
//       })
//     }
//   }

//   /**
//    * Affiche les détails d'un véhicule spécifique du driver connecté.
//    * GET /driver/vehicles/:id
//    * Nécessite: Auth, Rôle Driver
//    */
//   async show({ auth, params, response }: HttpContext) {
//     await auth.check()
//     const user = await auth.authenticate()
//     const vehicleId = params.id
//     const driver = await Driver.findBy('user_id', user.id)

//     if (!driver) {
//       logger.error({ userId: user.id }, 'Aucun driver trouvé pour ce user')
//       return response.unauthorized({ message: 'Aucun driver trouvé pour ce user.' })
//     }

//     try {
//       const vehicle = await DriverVehicle.query()
//         .where('id', vehicleId)
//         .andWhere('driver_id', driver.id) // Vérifie que le véhicule appartient bien au driver connecté
//         .first()

//       if (!vehicle) {
//         return response.notFound({ message: 'Véhicule non trouvé ou non autorisé.' })
//       }

//       return response.ok(vehicle)
//     } catch (error) {
//       logger.error(
//         { err: error, driverId: user.id, vehicleId },
//         'Erreur récupération détail véhicule'
//       )
//       return response.internalServerError({
//         message: 'Erreur lors de la récupération du véhicule.',
//       })
//     }
//   }

//   /**
//    * Ajoute un nouveau véhicule pour le driver connecté.
//    * POST /driver/vehicles
//    * Nécessite: Auth, Rôle Driver
//    */
//   async create_vehicle({ auth, request, response }: HttpContext) {
//     await auth.check()
//     const user = await auth.authenticate() // ID du driver connecté

//     const driver = await Driver.findBy('user_id', user.id)

//     if (!driver) {
//       logger.error({ userId: user.id }, 'Aucun driver trouvé pour ce user')
//       return response.unauthorized({ message: 'Aucun driver trouvé pour ce user.' })
//     }
//     let payload: any
//     try {
//       payload = await request.validateUsing(driverVehicleValidator)
//     } catch (error) {
//       logger.error({ err: error, driverId: user.id }, 'Erreur validation véhicule')
//       return response.badRequest({ message: 'Erreur lors de la validation du véhicule.' })
//     }

//     let newVehicle: DriverVehicle | null = null
//     let vehicleImageUrls: string[] = [] // URLs finales des images
//     let vehicleDocumentUrls: string[] = [] // URLs finales des documents
//     let licenseImageUrls: string[] = [] // URLs finales des documents
//     // Pas besoin de transaction pour une simple création normalement,
//     // mais utile si on gère le rollback fichier. Utilisons-la pour la cohérence.
//     const trx = await db.transaction()
//     const vehicleId = cuid()

//     try {
//       // 1. Gérer les images avec createFiles (même si création, pour la cohérence)
//       vehicleImageUrls = await createFiles({
//         request: request,
//         table_id: vehicleId, // Utilise un ID prévisible (mais attention aux collisions potentielles si format pas assez unique) - peut-être mieux: temporaire ou table_id sera l'ID du véhicule une fois créé ? On va utiliser l'ID du *futur* véhicule pour lier.
//         table_name: 'driver_vehicles',
//         column_name: 'vehicle_image',
//         options: {
//           maxSize: 5 * 1024 * 1024, // Exemple : 5MB max par fichier
//           // resize: { width: 800, height: 600 },
//           extname: ['jpg', 'jpeg', 'png', 'webp'],
//           compress: 'img',
//           min: 1, // Exemple: au moins 1 image requise
//           throwError: true // Pour renvoyer une erreur claire si validation échoue
//         }
//       })

//       vehicleDocumentUrls = await createFiles({
//         request: request,
//         table_id: vehicleId, // Utilise un ID prévisible (mais attention aux collisions potentielles si format pas assez unique) - peut-être mieux: temporaire ou table_id sera l'ID du véhicule une fois créé ? On va utiliser l'ID du *futur* véhicule pour lier.
//         table_name: 'driver_vehicles',
//         column_name: 'vehicle_document',
//         options: {
//           maxSize: 5 * 1024 * 1024, // Exemple : 5MB max par fichier
//           // resize: { width: 800, height: 600 },
//           extname: ['jpg', 'jpeg', 'png', 'webp'],
//           compress: 'img',
//           min: 1, // Exemple: au moins 1 image requise
//           throwError: true // Pour renvoyer une erreur claire si validation échoue
//         }
//       })

//       // licenseImageUrls = await createFiles({
//       //   request: request,
//       //   table_id: vehicleId, // Utilise un ID prévisible (mais attention aux collisions potentielles si format pas assez unique) - peut-être mieux: temporaire ou table_id sera l'ID du véhicule une fois créé ? On va utiliser l'ID du *futur* véhicule pour lier.
//       //   table_name: 'driver_vehicles',
//       //   column_name: 'license_image',
//       //   options: {
//       //     maxSize: 5 * 1024 * 1024, // Exemple : 5MB max par fichier
//       //     // resize: { width: 800, height: 600 },
//       //     extname: ['jpg', 'jpeg', 'png', 'webp'],
//       //     compress: 'img',
//       //     min: 1, // Exemple: au moins 1 image requise
//       //     throwError: true // Pour renvoyer une erreur claire si validation échoue
//       //   }
//       // })

//       const now = DateTime.utc()

//       const fullDate = DateTime.fromISO(`${payload.insurance_expiry_date}T${now.toFormat('HH:mm:ss.SSS')}`, { zone: 'utc' })

//       // 2. Créer l'enregistrement véhicule dans la transaction
//       newVehicle = await DriverVehicle.create(
//         {
//           id: vehicleId, // Génère l'ID du véhicule
//           driver_id: driver.id, // Lie au driver connecté
//           type: payload.type,
//           license_plate: payload.license_plate,
//           insurance_expiry_date: fullDate,
//           has_refrigeration: payload.has_refrigeration ?? false, // Valeur par défaut
//           status: VehicleStatus.PENDING, // Statut par défaut si non fourni
//           model: payload.model,
//           color: payload.color,
//           max_weight_kg: payload.max_weight_kg,
//           max_volume_m3: payload.max_volume_m3,
//           vehicle_image: vehicleImageUrls || [], // Sera mis à jour juste après avec les URLs finales
//           vehicle_document: vehicleDocumentUrls || [], // Sera mis à jour juste après avec les URLs finales
//           license_image: [], // Sera mis à jour juste après avec les URLs finales
//         },
//         { client: trx }
//       ) // Utilise la transaction

//       // 3. Mettre à jour les images avec l'ID réel (deuxième appel ou modification d'updateFiles)
//       // C'est là que la logique de updateFiles devient importante.
//       // Soit elle peut renommer les fichiers créés avec l'ID temporaire vers l'ID réel,
//       // soit on rappelle une fonction de mise à jour des URLs ou un simple save()
//       // Supposons ici qu'on fait un simple save() après la création des fichiers (un peu moins propre):

//       // Il faut relancer l'opération pour lier les fichiers au bon ID ou adapter updateFiles
//       // SOLUTION SIMPLIFIÉE: Créer SANS image, puis utiliser 'update' (PATCH) pour ajouter l'image ensuite.
//       // OU: Adapter 'createFile'/'updateFiles' pour accepter un ID après coup.

//       // Pour l'instant, nous allons supposer qu'updateFiles retourne les URLs finales et nous les sauvons
//       if (vehicleImageUrls.length > 0) {
//         newVehicle.vehicle_image = vehicleImageUrls
//         await newVehicle.save() // Sauve les URLs d'images dans la transaction
//       }

//       await trx.commit() // Commit la transaction

//       return response.created(newVehicle) // Retourne le véhicule créé
//     } catch (error) {
//       await trx.rollback()

//       // Tenter de supprimer les fichiers créés si nécessaire...
//       if (vehicleImageUrls.length > 0 && newVehicle?.id) {
//         // Si on avait un ID même temporaire
//         logger.warn(
//           `Rollback création véhicule pour driver ${user.id}, tentative suppression fichiers`
//         )
//         try {
//           await deleteFiles(`vehicle_${newVehicle.id}`, 'vehicle_image') // Adapte l'identifiant utilisé
//         } catch (deleteError) {
//           logger.error({ err: deleteError }, `Echec suppression fichier après rollback véhicule`)
//         }
//       } else if (vehicleImageUrls.length > 0) {
//         // Si pas d'ID véhicule mais fichiers créés (cas ID temporaire non géré par deleteFiles)
//         logger.warn(
//           `Rollback création véhicule pour driver ${user.id}, fichiers ${vehicleImageUrls} potentiellement orphelins.`
//         )
//       }

//       logger.error({ err: error, driverId: user.id }, 'Erreur création véhicule')
//       if (error.code === 'E_VALIDATION_ERROR') {
//         return response.badRequest({ errors: error.messages })
//       }
//       return response.internalServerError({ message: "Erreur lors de l'ajout du véhicule." })
//     }
//   }

//   /**
//    * Met à jour un véhicule existant du driver connecté.
//    * PATCH /driver/vehicles/:id
//    * PUT /driver/vehicles/:id
//    * Nécessite: Auth, Rôle Driver
//    */
//   async update_vehicle({ auth, params, request, response }: HttpContext) {
//     await auth.check()
//     const user = await auth.authenticate()
//     const vehicleId = params.id
//     const driver = await Driver.findBy('user_id', user.id)

//     if (!driver) {
//       logger.error({ userId: user.id }, 'Aucun driver trouvé pour ce user')
//       return response.unauthorized({ message: 'Aucun driver trouvé pour ce user.' })
//     }

//     const payload = await request.validateUsing(driverVehicleValidator)

//     const trx = await db.transaction()
//     let vehicle: DriverVehicle | null = null
//     let finalImageUrls: string[] = []
//     let oldUrlsOnError: string[] = []

//     try {
//       // 1. Trouver le véhicule et s'assurer qu'il appartient au driver (DANS la transaction)
//       vehicle = await DriverVehicle.query({ client: trx })
//         .where('id', vehicleId)
//         .andWhere('driver_id', driver.id)
//         .first()

//       if (!vehicle) {
//         await trx.rollback() // Pas besoin de continuer
//         return response.notFound({ message: 'Véhicule non trouvé ou non autorisé.' })
//       }
//       oldUrlsOnError = vehicle.vehicle_image // Sauvegarde anciennes URLs avant

//       let requiresRevalidation = false
//       const oldType = vehicle.type
//       const oldPlate = vehicle.license_plate
//       // Compare les anciennes valeurs critiques avec les nouvelles
//       if (payload.type !== undefined && payload.type !== oldType) requiresRevalidation = true
//       if (payload.license_plate !== undefined && payload.license_plate !== oldPlate)
//         requiresRevalidation = true
//       // Si de nouvelles images sont ajoutées/modifiées par updateFiles, on peut aussi forcer la revalidation
//       if (JSON.stringify(finalImageUrls) !== JSON.stringify(vehicle.vehicle_image)) {
//         // Comparaison simple des tableaux d'URLs
//         requiresRevalidation = true
//       }

//       // 2. Gérer la mise à jour des images via updateFiles
//       finalImageUrls = await updateFiles({
//         request: request,
//         table_id: vehicleId, // Utilise l'ID existant
//         table_name: 'driver_vehicles',
//         column_name: 'vehicle_image',
//         lastUrls: vehicle.vehicle_image || [], // URLs précédentes
//         newPseudoUrls: payload._vehicleImageNewPseudoUrls,
//         options: {
//           maxSize: 5 * 1024 * 1024,
//           extname: ['jpg', 'jpeg', 'png', 'webp'],
//         },
//       })

//       const now = DateTime.utc()
//       const fullDate = DateTime.fromISO(`${payload.insurance_expiry_date}T${now.toFormat('HH:mm:ss.SSS')}`, { zone: 'utc' })

//       // 3. Mettre à jour les champs du véhicule
//       // Merge ne met à jour que les champs définis dans le payload
//       vehicle.merge({
//         type: payload.type,
//         license_plate: payload.license_plate,
//         insurance_expiry_date: fullDate,
//         has_refrigeration: payload.has_refrigeration,
//         model: payload.model,
//         color: payload.color,
//         max_weight_kg: payload.max_weight_kg,
//         max_volume_m3: payload.max_volume_m3,
//         vehicle_image: finalImageUrls, // Met à jour avec les nouvelles URLs
//       })

//       if (requiresRevalidation) {
//         vehicle.status = VehicleStatus.PENDING // Repasse en attente si modif critique
//         logger.info(`Véhicule ${vehicleId} nécessite revalidation suite à une modification.`)
//       } else if (payload.status !== undefined) {
//         // Permet de changer le statut (ex: passer en MAINTENANCE) s'il est fourni ET pas de revalidation auto nécessaire
//         vehicle.status = payload.status
//       }

//       await vehicle.save() // Sauvegarde les modifs dans la transaction

//       await trx.commit() // Commit

//       return response.ok({
//         message: 'Véhicule mis à jour avec succès.',
//         vehicle: vehicle,
//       })
//     } catch (error) {
//       await trx.rollback()

//       // Pas de rollback fichier simple pour 'updateFiles' ici, car il gère interneement
//       // Cependant, si updateFiles lui-même a échoué AVANT l'erreur DB, les fichiers sont peut-être dans un état incohérent.
//       logger.error({ err: error, driverId: user.id, vehicleId }, 'Erreur mise à jour véhicule')
//       // Si c'était une erreur de validation du payload:
//       if (error.code === 'E_VALIDATION_ERROR') {
//         return response.badRequest({ errors: error.messages })
//       }
//       // Si le véhicule n'a pas été trouvé DANS la transaction (race condition ? ou juste ID invalide)
//       if (error.message.includes('non trouvé ou non autorisé')) {
//         // Adapter si le message change
//         return response.notFound({ message: 'Véhicule non trouvé ou non autorisé.' })
//       }
//       return response.internalServerError({ message: 'Erreur lors de la mise à jour du véhicule.' })
//     }
//   }

//   /**
//    * Supprime un véhicule du driver connecté.
//    * DELETE /driver/vehicles/:id
//    * Nécessite: Auth, Rôle Driver
//    */
//   async delete_vehicle({ auth, params, response }: HttpContext) {
//     await auth.check()
//     const user = await auth.authenticate()
//     const vehicleId = params.id
//     const driver = await Driver.findBy('user_id', user.id)

//     if (!driver) {
//       logger.error({ userId: user.id }, 'Aucun driver trouvé pour ce user')
//       return response.unauthorized({ message: 'Aucun driver trouvé pour ce user.' })
//     }

//     // Important : PAS de transaction nécessaire pour une simple suppression
//     // MAIS il faut supprimer les fichiers associés AVANT ou APRES

//     try {
//       const vehicle = await DriverVehicle.query()
//         .where('id', vehicleId)
//         .andWhere('driver_id', driver.id) // Vérifie propriété
//         .first()

//       if (!vehicle) {
//         return response.notFound({ message: 'Véhicule non trouvé ou non autorisé.' })
//       }

//       const urlsToDelete = vehicle.vehicle_image || []

//       // Supprime l'enregistrement de la base de données
//       await vehicle.delete()

//       // Ensuite, tente de supprimer les fichiers associés (best-effort)
//       if (urlsToDelete.length > 0) {
//         logger.info(
//           `Véhicule ${vehicleId} supprimé, tentative de suppression des fichiers associés...`
//         )
//         try {
//           // deleteFiles devrait pouvoir supprimer basé sur l'ID utilisé pour le nommage
//           await deleteFiles(`vehicle_${vehicleId}`, 'vehicle_image') // Adapte l'ID et fieldName
//           logger.info(`Fichiers pour véhicule ${vehicleId} supprimés.`)
//         } catch (deleteError) {
//           logger.error(
//             { err: deleteError },
//             `Echec de suppression des fichiers pour véhicule ${vehicleId}. Suppression manuelle peut être nécessaire.`
//           )
//         }
//       }

//       return response.noContent() // Succès sans contenu retourné
//     } catch (error) {
//       logger.error({ err: error, driverId: user.id, vehicleId }, 'Erreur suppression véhicule')
//       return response.internalServerError({ message: 'Erreur lors de la suppression du véhicule.' })
//     }
//   }

//   /**
//    * Liste les véhicules enregistrés, avec filtres optionnels (status, driver_id, etc.).
//    * Idéal pour lister les véhicules en attente (status=pending).
//    * GET /admin/vehicles
//    * Nécessite: Auth, Rôle Admin/Moderator
//    */
//   async list_vehicles({ request, response, auth }: HttpContext) {
//     const adminUser = auth.getUserOrFail()
//     logger.info(`Admin ${adminUser.id} requested vehicle list`)

//     try {
//       // Valider les paramètres de la query string (filtres, pagination)
//       const queryParams = await request.validateUsing(listVehiclesQueryValidator)

//       // Commence la requête de base
//       const query = DriverVehicle.query().preload('driver', (driverQuery) => {
//         // Précharge le driver associé
//         //@ts-ignore
//         driverQuery.preload('user') // Précharge l'utilisateur du driver pour avoir son nom/email
//       })

//       // Applique les filtres s'ils sont présents
//       if (queryParams.status) {
//         query.where('status', queryParams.status)
//         logger.debug(`Filtering vehicles by status: ${queryParams.status}`)
//       }
//       if (queryParams.driver_id) {
//         query.where('driver_id', queryParams.driver_id)
//         logger.debug(`Filtering vehicles by driver_id: ${queryParams.driver_id}`)
//       }
//       if (queryParams.license_plate) {
//         // Utilise 'ilike' pour une recherche insensible à la casse et partielle
//         query.where('license_plate', 'ilike', `%${queryParams.license_plate}%`)
//         logger.debug(`Filtering vehicles by license_plate like: ${queryParams.license_plate}`)
//       }

//       // Applique la pagination
//       const page = queryParams.page || 1
//       const perPage = queryParams.perPage || 20 // 20 par défaut
//       const vehiclesPaginated = await query.orderBy('created_at', 'desc').paginate(page, perPage) // Trie par défaut les plus récents

//       return response.ok(vehiclesPaginated.toJSON()) // Retourne les données paginées en JSON
//     } catch (error) {
//       logger.error(
//         { err: error, adminId: adminUser.id },
//         'Erreur récupération liste véhicules par admin'
//       )
//       if (error.code === 'E_VALIDATION_ERROR') {
//         return response.badRequest({ errors: error.messages })
//       }
//       return response.internalServerError({
//         message: 'Erreur lors de la récupération de la liste des véhicules.',
//       })
//     }
//   }

//   async get_vehicle_details({ params, response, auth }: HttpContext) {
//     const adminUser = auth.getUserOrFail()
//     const vehicleId = params.vehicleId // Utilise le nom du paramètre dans la route
//     logger.info(`Admin ${adminUser.id} requested details for vehicle ${vehicleId}`)

//     try {
//       // Récupère le véhicule par ID et précharge les informations utiles
//       const vehicle = await DriverVehicle.query()
//         .where('id', vehicleId)
//         .preload('driver', (driverQuery) => {
//           // Précharge le driver ET l'utilisateur associé pour les infos
//           //@ts-ignore
//           driverQuery.preload('user')
//           // Précharge aussi les documents de l'utilisateur/driver si nécessaire
//           // pour une vue complète (assurance, permis)
//           // driverQuery.preload('user_document') // Ou charger user_document sur 'user' ? dépend du modèle
//         })
//         // Tu pourrais aussi vouloir charger le user_document associé au driver ici
//         // .preload('driver', query => query.preload('user_document'))
//         .first() // Attend un seul résultat

//       if (!vehicle) {
//         return response.notFound({ message: 'Véhicule non trouvé.' })
//       }

//       // On peut vouloir charger les documents liés au user/driver pour les admins ici aussi
//       // const driver = vehicle.driver; // Récupère le driver préchargé
//       // if (driver) await driver.load('user_document'); // Charge les docs du driver si non déjà fait

//       return response.ok(vehicle.toJSON()) // Retourne l'objet véhicule complet
//     } catch (error) {
//       logger.error(
//         { err: error, vehicleId, adminId: adminUser.id },
//         'Erreur récupération détail véhicule par admin'
//       )
//       return response.internalServerError({
//         message: 'Erreur lors de la récupération des détails du véhicule.',
//       })
//     }
//   }

//   async admin_update_status({ params, request, response, auth }: HttpContext) {
//     const adminUser = auth.getUserOrFail()
//     const vehicleId = params.id
//     logger.info(`Admin ${adminUser.id} attempt update status for vehicle ${vehicleId}`)
//     const trx = await db.transaction() // Utilise la transaction ici

//     try {
//       const { status } = await request.validateUsing(updateVehicleStatusValidator) // Valide D'ABORD
//       const vehicle = await DriverVehicle.find(vehicleId, { client: trx }) // Cherche ENSUITE

//       if (!vehicle) {
//         await trx.rollback()
//         return response.notFound({ message: 'Véhicule non trouvé.' })
//       }
//       const driver = await Driver.find(vehicle.driver_id, { client: trx }) // Cherche ENSUITE
//       if (!driver) {
//         await trx.rollback()
//         return response.notFound({ message: 'Conducteur non trouvé.' })
//       }
//       const oldStatus = vehicle.status
//       vehicle.status = status
//       await vehicle.useTransaction(trx).save()
//       // TODO: AuditLog, Notification?
//       await trx.commit()
//       let fcmToken = driver.fcm_token
//       logger.info(`FCM Token: ${fcmToken}`)
//       let title = 'Statut véhicule mis à jour'
//       let body = `Le statut de votre véhicule ${vehicle.license_plate} a été mis à jour.`
//       if (fcmToken) {
//         redis_helper.enqueuePushNotification({
//           fcmToken,
//           title,
//           body,
//           data: { vehicle_id: vehicle.id, type: NotificationType.VEHICLE_STATUS_UPDATE },
//         })
//       } else {
//         logger.warn(`No FCM token found for vehicle ${vehicle.id}`)
//       }
//       logger.info(
//         `Statut véhicule ${vehicleId} mis à jour (${oldStatus} -> ${status}) par admin ${adminUser.id}`
//       )
//       return response.ok({
//         message: `Statut du véhicule mis à jour avec succès à "${status}".`,
//         vehicle: vehicle,
//       })
//     } catch (error) {
//       await trx.rollback() // Assure le rollback en cas d'erreur après début transaction
//       // --- Gestion Erreur admin_update_status ---
//       logger.error(
//         { err: error, vehicleId, adminId: adminUser.id },
//         'Erreur MàJ statut véhicule par admin'
//       )

//       if (error.code === 'E_VALIDATION_ERROR') {
//         // Erreur de validation du corps de la requête (statut invalide, etc.)
//         return response.badRequest({
//           message: 'Données de mise à jour invalides.',
//           errors: error.messages,
//         })
//       }
//       // Erreur pendant l'opération BDD ou autre
//       return response.internalServerError({
//         message: 'Erreur serveur lors de la mise à jour du statut du véhicule.',
//       })
//       // --- Fin Gestion Erreur ---
//     }
//   }
// }
