/* eslint-disable @typescript-eslint/naming-convention */
import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import db from '@adonisjs/lucid/services/db'
import UserDocument, { DocumentType } from '#models/user_document'
import Driver from '#models/driver' // Important pour lier le document au driver
import { DocumentStatus } from '#models/user_document'
// import { userDocumentValidator } from '#validators/user_document_validator'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import { cuid } from '@adonisjs/core/helpers'
import vine from '@vinejs/vine'
import { updateFiles } from '#services/media/UpdateFiles'
import redis_helper from '#services/redis_helper'
import { NotificationType } from '#models/notification'
import { createFiles } from '#services/media/CreateFiles'
import DriverVehicle from '#models/driver_vehicle'

const expirationDateRule = vine.string().transform((value: string) => {
  if (!value.match(/^\d{4}-\d{2}-\d{2}$/)) {
    throw new Error("La date d'expiration doit être au format YYYY-MM-DD")
  }
  const date = DateTime.fromISO(value, { zone: 'utc' })

  if (!date.isValid) {
    throw new Error('La date est invalide.')
  }

  const today = DateTime.utc().startOf('day')
  const maxFutureDate = today.plus({ years: 20 })

  if (date <= today) {
    throw new Error("La date d'expiration doit être dans le futur.")
  }

  if (date > maxFutureDate) {
    throw new Error("La date d'expiration est trop lointaine.")
  }

  return value
})

export const userDocumentValidator = vine.compile(
  vine.object({
    type: vine.enum(DocumentType), // Important de savoir quel type de document est uploadé

    identity_document_images: vine
      .string().optional(),

    driving_license_images: vine
      .string().optional(),

    // Dates d'expiration (chaîne YYYY-MM-DD)
    identity_document_expiry_date: expirationDateRule.optional(),
    driving_license_expiry_date: expirationDateRule.optional(),

    // On récupère les noms des fichiers uploadés (clefs du form-data)
    // Ces champs sont spéciaux et souvent remplis côté front avec les clefs
    // que updateFiles attendra (ex: identity_document_images_pseudo_urls)
    // Vine ne valide pas directement le contenu ici mais leur présence peut être utile
    // _identityDocumentNewPseudoUrls: vine.string().optional(), // Clé spéciale que le front peut envoyer
    // _drivingLicenseNewPseudoUrls: vine.string().optional(), // Clé spéciale
  })
)

@inject()
export default class UserDocumentController {
  /**
   * Récupère les documents soumis par le driver connecté.
   * GET /driver/documents
   * Nécessite: Auth, Rôle Driver
   */
  async show({ auth, response }: HttpContext) {
    await auth.check()
    const user = await auth.authenticate() // ID du driver connecté
    const driver = await Driver.findBy('user_id', user.id)

    if (!driver) {
      return response.unauthorized({ message: 'Aucun driver trouvé pour ce user.' })
    }

    try {
      const document = await UserDocument.query().where('driver_id', driver.id).first()

      return response.ok(document)
    } catch (error) {
      logger.error({ err: error, userId: user.id }, 'Erreur récupération UserDocument')
      return response.internalServerError({
        message: 'Erreur lors de la récupération des documents.',
      })
    }
  }

  public async uploadDocument({ request, auth, response }: HttpContext) {
    const user = auth.user!
    await user.load('driver')
    const driver = user.driver

    if (!driver) {
      return response.unauthorized({ error: "Livreur non trouvé." })
    }

    // --- Récupération des données ---
    // Votre frontend envoie le type de document et les métadonnées
    const type = request.input('type') as DocumentType
    const metadataInput = request.input('metadata')
    let metadata = null;
    try {
        // Les métadonnées sont envoyées en tant que chaîne JSON, il faut les parser
        if (metadataInput) {
            metadata = JSON.parse(metadataInput);
        }
    } catch (error) {
        return response.badRequest({ error: 'Les métadonnées ne sont pas un JSON valide.'})
    }
    
    // Le frontend vous a dit quel champ utiliser pour les fichiers
    // Par exemple : "driver_license_files" ou "national_id_files"
    // On doit le déduire du 'type' pour le passer à createFiles
    const fieldNameMapping: Record<string, string> = {
        [DocumentType.DRIVER_LICENSE]: 'driver_license_files',
        [DocumentType.NATIONAL_ID]: 'national_id_files',
        [DocumentType.SELFIE]: 'files', // Nom de champ pour le selfie
        [DocumentType.VEHICLE_PHOTOS]: 'files', // Nom de champ pour les photos du véhicule
    };

    const uploadFieldName = fieldNameMapping[type];
    if (!uploadFieldName) {
        return response.badRequest({ error: `Type de document inconnu: ${type}`})
    }

    // --- Traitement des fichiers avec VOTRE logique ---
    let fileUrls: string[] = [];
    try {
      // 2. On appelle votre helper `createFiles`
      fileUrls = await createFiles({
        request: request,
        table_id: driver.id, // On lie les fichiers à l'ID du livreur
        table_name: 'user_documents',
        column_name: uploadFieldName, // On utilise le nom de champ dynamique
        options: {
          maxSize: 10 * 1024 * 1024, // 10MB, par exemple
          extname: ['jpg', 'jpeg', 'png', 'webp'],
          compress: 'img',
          throwError: true, // Important pour attraper les erreurs
        }
      })

      if (fileUrls.length === 0) {
        return response.badRequest({ error: 'Aucun fichier valide n\'a été traité.'})
      }
      
    } catch (error) {
      logger.error(error, `Erreur lors du traitement des fichiers pour le livreur ${driver.id}`)
      return response.internalServerError({ message: 'Erreur lors du traitement des fichiers.', error: error.message })
    }

    // --- Sauvegarde en base de données ---
    try {
      // 3. On utilise `updateOrCreate` pour gérer la mise à jour et la création
      // On cherche un document existant pour ce livreur ET de ce type, et on le met à jour.
      // S'il n'existe pas, on le crée.
      const document = await UserDocument.updateOrCreate(
        {
          driver_id: driver.id,
          type: type,
        },
        {
          file_urls: fileUrls, // Les URLs retournées par votre helper
          metadata: metadata,
          status: DocumentStatus.PENDING, // A chaque nouvelle soumission, on repasse le statut en 'pending'
          submitted_at: DateTime.now(),
          rejection_reason: null, // On efface l'ancienne raison de rejet s'il y en avait une
        }
      )

      logger.info({ documentId: document.id }, `Document pour le livreur ${driver.id} sauvegardé avec succès.`)
      return response.created(document)

    } catch (error) {
      logger.error(error, `Erreur de sauvegarde en base de données pour le livreur ${driver.id}`)
      // [TODO] Ajouter une logique pour supprimer les fichiers qui viennent d'être uploadés si la DB échoue
      return response.internalServerError({ message: 'Erreur lors de la sauvegarde du document.', error: error.message })
    }
  }



  public async getStatus({ auth, response }: HttpContext) {
    const ALL_REQUIREMENTS_CONFIG = [
      {
        type: DocumentType.NATIONAL_ID,
        minFiles: 1,
        maxFiles: 2,
      },
      {
        type: DocumentType.DRIVER_LICENSE,
        minFiles: 2,
        maxFiles: 2,
      },
      {
        type: DocumentType.SELFIE,
        minFiles: 2,
        maxFiles: 2,
      },
      // On pourrait ajouter VEHICLE_PHOTOS ici si c'est toujours requis
      {
        type: DocumentType.VEHICLE_PHOTOS,
        minFiles: 4,
        maxFiles: 5,
      }
    ]
    const user = auth.user!
    await user.load('driver')
    const driver = user.driver
    if (!driver) {
      return response.unauthorized({ error: 'Livreur non trouvé' })
    }

    // 1. Récupérer TOUS les documents que ce livreur a déjà soumis.
    const submittedDocs = await UserDocument.query().where('driver_id', driver.id)

    // 2. Vérifier si le livreur a au moins un véhicule enregistré.
    const vehicleCount = await DriverVehicle.query().where('driver_id', driver.id).count('* as total')
    const hasVehicle = Number(vehicleCount[0].$extras.total) > 0

    // 3. Construire la liste des "requirements" en comparant la config et les documents soumis.
    const requirements = ALL_REQUIREMENTS_CONFIG.map(config => {
      const submittedDoc = submittedDocs.find(doc => doc.type === config.type)

      if (submittedDoc) {
        // Le livreur a soumis ce document, on retourne son statut actuel.
        return {
          type: submittedDoc.type,
          status: submittedDoc.status,
          rejectionReason: submittedDoc.rejection_reason,
          lastUpdate: submittedDoc.updated_at.toISO(),
          minFiles: config.minFiles,
          maxFiles: config.maxFiles,
        }
      } else {
        // Le livreur n'a pas encore soumis ce document.
        return {
          type: config.type,
          status: 'MISSING', // Le statut est "manquant"
          rejectionReason: null,
          lastUpdate: null,
          minFiles: config.minFiles,
          maxFiles: config.maxFiles,
        }
      }
    })

    // 4. Déterminer si le livreur est globalement valide.
    // Il est valide si TOUS les requirements ont le statut 'APPROVED'.
    const isDriverValid = requirements.every(req => req.status === DocumentStatus.APPROVED)

    // 5. Construire et envoyer la réponse finale, qui correspond à la structure attendue par le frontend.
    const responsePayload = {
      isValid: isDriverValid,
      hasVehicle: hasVehicle,
      requirements: requirements,
    }

    return response.ok(responsePayload)
  }

  /**
   * Permet à un driver de soumettre ou de mettre à jour ses documents.
   * POST /driver/documents
   * Nécessite: Auth, Rôle Driver
   */
  // public async store_or_update({ auth, request, response }: HttpContext) {
  //   await auth.check()
  //   const user = await auth.authenticate()

  //   logger.info({ data: request.allFiles() }, 'User trouvé')

  //   const driver = await Driver.query()
  //     .where('user_id', user.id)
  //     .preload('user_document')
  //     .first()

  //   if (!driver) {
  //     logger.error({ userId: user.id }, 'Aucun driver trouvé pour ce user')
  //     return response.unauthorized({ message: 'Aucun driver trouvé pour ce user.' })
  //   }

  //   let validated
  //   try {
  //     validated = await request.validateUsing(userDocumentValidator)
  //   } catch (error) {
  //     logger.error({ err: error }, 'Erreur validation documents')
  //     return response.badRequest({ errors: error.messages })
  //   }

  //   const {
  //     identity_document_expiry_date,
  //     driving_license_expiry_date,
  //     identity_document_images,
  //     driving_license_images,
  //     type,
  //   } = validated

  //   const userIdForFiles = driver.id

  //   const identityFilesPresent = request.files('identity_document_images_0')?.length > 0
  //   logger.info({ identityFilesPresent }, 'identityFilesPresent')
  //   const licenseFilesPresent = request.files('driving_license_images_0')?.length > 0
  //   logger.info({ licenseFilesPresent }, 'licenseFilesPresent')

  //   if (identityFilesPresent && !identity_document_expiry_date) {
  //     return response.badRequest({
  //       errors: [
  //         {
  //           field: 'identity_document_expiry_date',
  //           message: "La date d'expiration est requise si des images d'identité sont fournies.",
  //         },
  //       ],
  //     })
  //   }

  //   if (licenseFilesPresent && !driving_license_expiry_date) {
  //     return response.badRequest({
  //       errors: [
  //         {
  //           field: 'driving_license_expiry_date',
  //           message: "La date d'expiration est requise si des images de permis sont fournies.",
  //         },
  //       ],
  //     })
  //   }

  //   const trx = await db.transaction()

  //   try {
  //     const optionsForFiles = {
  //       maxSize: 5 * 1024 * 1024,
  //       extnames: ['jpg', 'jpeg', 'png', 'pdf', 'webp'],
  //       min: 2,
  //       max: 2,
  //     }

  //     let finalIdentityUrls: string[] = []
  //     if (identityFilesPresent) {
  //       finalIdentityUrls = await updateFiles({
  //         request,
  //         table_id: userIdForFiles,
  //         table_name: 'user_documents',
  //         column_name: 'identity_document_images',
  //         lastUrls: driver.user_document?.identity_document_images || [],
  //         newPseudoUrls: identity_document_images,
  //         options: optionsForFiles,
  //       })
  //     }

  //     let finalLicenseUrls: string[] = []
  //     if (licenseFilesPresent) {
  //       finalLicenseUrls = await updateFiles({
  //         request,
  //         table_id: userIdForFiles,
  //         table_name: 'user_documents',
  //         column_name: 'driving_license_images',
  //         lastUrls: driver.user_document?.driving_license_images || [],
  //         newPseudoUrls: driving_license_images,
  //         options: optionsForFiles,
  //       })
  //     }

  //     const dataToSave: Partial<UserDocument> & { driver_id: string } = {
  //       driver_id: driver.id,
  //       type,
  //       identity_document_images: finalIdentityUrls.length > 0 ? finalIdentityUrls : driver.user_document?.identity_document_images,
  //       driving_license_images: finalLicenseUrls.length > 0 ? finalLicenseUrls : driver.user_document?.driving_license_images,
  //       identity_document_expiry_date: identity_document_expiry_date
  //         ? DateTime.fromISO(identity_document_expiry_date)
  //         : driver.user_document?.identity_document_expiry_date,
  //       driving_license_expiry_date: driving_license_expiry_date
  //         ? DateTime.fromISO(driving_license_expiry_date)
  //         : driver.user_document?.driving_license_expiry_date,
  //       status: DocumentStatus.PENDING,
  //       submitted_at: DateTime.now(),
  //       rejection_reason: null,
  //       verified_at: null,
  //     }

  //     let userDocument = driver.user_document

  //     if (userDocument) {
  //       userDocument.merge(dataToSave)
  //       await userDocument.useTransaction(trx).save()
  //       logger.info(`UserDocument ${userDocument.id} mis à jour pour user ${user.id}`)
  //     } else {
  //       //@ts-ignore
  //       userDocument = await UserDocument.create({ ...dataToSave, id: cuid() }, { client: trx })
  //       logger.info(`UserDocument ${userDocument.id} créé pour user ${user.id}`)
  //     }

  //     await trx.commit()

  //     return response.ok({
  //       message: 'Documents soumis avec succès. Ils sont en attente de validation.',
  //       document: userDocument.serialize(),
  //     })
  //   } catch (error) {
  //     await trx.rollback()
  //     logger.error({ err: error, userId: user.id }, 'Erreur lors de la soumission/màj UserDocument')
  //     return response.internalServerError({
  //       message: 'Erreur lors de la soumission des documents.',
  //     })
  //   }
  // }

  listDocumentsQueryValidator = vine.compile(
    vine.object({
      status: vine.enum(DocumentStatus).optional(),
      user_id: vine.string().optional(),
      page: vine.number().min(1).optional(),
      perPage: vine.number().min(1).max(100).optional(),
    })
  )

  async admin_index({ request, response, auth }: HttpContext) {
    const adminUser = auth.getUserOrFail()
    try {
      const queryParams = await request.validateUsing(this.listDocumentsQueryValidator)
      //@ts-ignore
      const query = UserDocument.query().preload('driver', (q) => q.preload('user'))
      if (queryParams.user_id) {
        query.where('user_id', queryParams.user_id)
      }
      if (queryParams.status) {
        query.where('status', queryParams.status)
      }
      const page = queryParams.page || 1
      const perPage = queryParams.perPage || 20
      const documentsPaginated = await query.orderBy('submitted_at', 'desc').paginate(page, perPage)
      return response.ok(documentsPaginated.toJSON())
    } catch (error) {
      logger.error(
        { err: error, adminId: adminUser.id },
        'Erreur récupération liste documents par admin'
      )
      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({
          message: 'Paramètres de requête invalides.',
          errors: error.messages,
        })
      }
      return response.internalServerError({
        message: 'Erreur serveur lors de la récupération de la liste des documents.',
      })
      // --- Fin Gestion Erreur ---
    }
  }

  /**
   * [ADMIN] Affiche les détails d'un UserDocument spécifique par son ID.
   * GET /admin/documents/:id
   */
  async admin_show({ params, response, auth }: HttpContext) {
    const adminUser = auth.getUserOrFail()
    const documentId = params.id
    try {
      const document = await UserDocument.query()
        .where('id', documentId)
        //@ts-ignore
        .preload('driver', (q) => q.preload('user'))
        .first()
      if (!document) {
        return response.notFound({ message: 'Document non trouvé.' })
      }
      return response.ok(document.toJSON())
    } catch (error) {
      // --- Gestion Erreur admin_show ---
      logger.error(
        { err: error, documentId, adminId: adminUser.id },
        'Erreur récupération détail document par admin'
      )
      // Ajouter gestion spécifique d'erreur si nécessaire (ex: ID invalide)
      return response.internalServerError({
        message: 'Erreur serveur lors de la récupération des détails du document.',
      })
      // --- Fin Gestion Erreur ---
    }
  }

  async admin_update_status({ params, request, response, auth }: HttpContext) {
    const adminUser = auth.getUserOrFail()
    const documentId = params.id
    logger.info(`Admin ${adminUser.id} attempt update status for document ${documentId}`)
    const trx = await db.transaction() // Transaction est importante ici (UserDocument + User)

    const updateDocumentStatusValidator = vine.compile(
      vine.object({
        status: vine.enum(DocumentStatus),
        rejection_reason: vine.string().optional(),
      })
    )

    try {
      const { status, rejection_reason } = await request.validateUsing(
        updateDocumentStatusValidator
      )
      const userDocument = await UserDocument.find(documentId, { client: trx })

      if (!userDocument) {
        await trx.rollback()
        return response.notFound({ message: 'Document non trouvé.' })
      }


      const oldStatus = userDocument.status

      // Mettre à jour UserDocument
      userDocument.status = status
      userDocument.rejection_reason = rejection_reason ?? null
      userDocument.verified_at = status === DocumentStatus.APPROVED ? DateTime.now() : null
      await userDocument.save()


      const driver = await Driver.query()
        .where('id', userDocument.driver_id)
        .first()
      if (!driver) {
        throw new Error(`Utilisateur ${userDocument.driver_id} non trouvé`)
      }
      driver.is_valid_driver = status === DocumentStatus.APPROVED
      await driver.save()
      logger.info(`Driver validity user ${driver.user_id} set to ${driver.is_valid_driver}`)

      await trx.commit()

      if (!driver.fcm_token) {
        logger.warn(`No FCM token found for driver ${driver.id}`)
      }
      let fcmToken = driver.fcm_token
      let title = 'Documents soumis'
      let body = 'Vos documents ont été mis à jour.'
      if (fcmToken) {
        redis_helper.enqueuePushNotification({
          fcmToken,
          title,
          body,
          data: { document_id: documentId, type: NotificationType.DOCUMENT_STATUS_UPDATE },
        })
      } else {
        logger.warn(`No FCM token found for driver ${driver.id}`)
      }
      logger.info(
        `Statut UserDocument ${documentId} (${oldStatus} -> ${status}) updated by admin ${adminUser.id}`
      )
      return response.ok({
        message: 'Statut du document mis à jour avec succès.',
        document: userDocument.serialize(),
      })
    } catch (error) {
      await trx.rollback()
      logger.error(
        { err: error, documentId, adminId: adminUser.id },
        'Erreur MàJ statut document par admin'
      )

      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({
          message: 'Données de mise à jour invalides.',
          errors: error.messages,
        })
      }
      if (error.message.includes('Utilisateur') && error.message.includes('non trouvé')) {
        return response.internalServerError({
          message: "Erreur critique: l'utilisateur associé à ce document est introuvable.",
        })
      }
      return response.internalServerError({
        message: 'Erreur serveur lors de la mise à jour du statut du document.',
      })
    }
  }
}
