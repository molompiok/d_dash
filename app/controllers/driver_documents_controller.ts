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

    // Les images : On valide leur présence/type mais updateFiles gèrera le reste
    identity_document_images: vine
      .array(
        vine.file({
          size: '5mb', // Ajuste la taille
          extnames: ['jpg', 'jpeg', 'png', 'pdf', 'webp'], // Ajuste les extensions
        })
      )
      .optional(), // Peut être optionnel si on met à jour seulement le permis

    driving_license_images: vine
      .array(
        vine.file({
          size: '5mb',
          extnames: ['jpg', 'jpeg', 'png', 'pdf', 'webp'],
        })
      )
      .optional(), // Idem

    // Dates d'expiration (chaîne YYYY-MM-DD)
    identity_document_expiry_date: expirationDateRule.optional(),
    driving_license_expiry_date: expirationDateRule.optional(),

    // On récupère les noms des fichiers uploadés (clefs du form-data)
    // Ces champs sont spéciaux et souvent remplis côté front avec les clefs
    // que updateFiles attendra (ex: identity_document_images_pseudo_urls)
    // Vine ne valide pas directement le contenu ici mais leur présence peut être utile
    _identityDocumentNewPseudoUrls: vine.string().optional(), // Clé spéciale que le front peut envoyer
    _drivingLicenseNewPseudoUrls: vine.string().optional(), // Clé spéciale
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
    const user = auth.getUserOrFail()

    try {
      // Trouve le document directement via l'ID utilisateur
      const document = await UserDocument.query().where('user_id', user.id).first()

      if (!document) {
        return response.notFound({ message: 'Aucun document trouvé pour ce livreur.' })
      }

      // Charge l'utilisateur associé si besoin (optionnel car on l'a déjà via auth)
      // await document.load('user')

      return response.ok(document)
    } catch (error) {
      logger.error({ err: error, userId: user.id }, 'Erreur récupération UserDocument')
      return response.internalServerError({
        message: 'Erreur lors de la récupération des documents.',
      })
    }
  }

  /**
   * Permet à un driver de soumettre ou de mettre à jour ses documents.
   * POST /driver/documents
   * Nécessite: Auth, Rôle Driver
   */
  async store_or_update({ auth, request, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()

    // Logique supplémentaire pour s'assurer que le user EST un driver
    // Le middleware acl:driver devrait le faire, mais double vérification
    if (user.role !== 'driver') {
      return response.forbidden({ message: 'Action non autorisée.' })
    }

    // 1. Valider les données de la requête
    const {
      identity_document_expiry_date,
      driving_license_expiry_date,
      _identityDocumentNewPseudoUrls, // Récupère les clefs spéciales si utilisées
      _drivingLicenseNewPseudoUrls,
    } = await request.validateUsing(userDocumentValidator)

    // On utilise l'ID utilisateur comme référence stable
    const userIdForFiles = user.id

    // 2. Logique de validation conditionnelle
    // Note : request.allFiles() pourrait être plus simple si updateFiles le gère.
    const identityFilesPresent = request.files('identity_document_images')?.length > 0
    const licenseFilesPresent = request.files('driving_license_images')?.length > 0

    if (identityFilesPresent && !identity_document_expiry_date) {
      return response.badRequest({
        errors: [
          {
            field: 'identity_document_expiry_date',
            message: "La date d'expiration est requise si des images d'identité sont fournies.",
          },
        ],
      })
    }
    if (licenseFilesPresent && !driving_license_expiry_date) {
      return response.badRequest({
        errors: [
          {
            field: 'driving_license_expiry_date',
            message: "La date d'expiration est requise si des images de permis sont fournies.",
          },
        ],
      })
    }

    // 3. Début Transaction
    const trx = await db.transaction()
    let userDocument: UserDocument | null = null

    try {
      // 4. Trouver le document existant (dans la transaction)
      userDocument = await UserDocument.query({ client: trx })
        .where('user_id', userIdForFiles)
        .first()

      // 5. Utiliser updateFiles pour gérer chaque groupe d'images
      const optionsForFiles = {
        maxSize: 5 * 1024 * 1024, // 5MB
        extnames: ['jpg', 'jpeg', 'png', 'pdf', 'webp'],
        // Pas besoin de throwError ici, on gère les erreurs globalement
      }

      // Appelle updateFiles pour les documents d'identité
      const finalIdentityUrls = await updateFiles({
        request: request, // L'objet request entier
        table_id: userIdForFiles, // Utilise user ID
        table_name: 'user_documents', // ou 'users' selon ta logique de nommage de fichiers
        column_name: 'identity_document_images', // Nom de la colonne/champ
        lastUrls: userDocument?.identity_document_images || [], // URLs précédentes
        newPseudoUrls: _identityDocumentNewPseudoUrls, // Le champ "meta" du validateur si tu l'utilises
        options: optionsForFiles,
        // distinct: user.id, // Si tu as besoin d'un préfixe distinct
      })

      // Appelle updateFiles pour le permis de conduire
      const finalLicenseUrls = await updateFiles({
        request: request,
        table_id: userIdForFiles,
        table_name: 'user_documents',
        column_name: 'driving_license_images',
        lastUrls: userDocument?.driving_license_images || [],
        newPseudoUrls: _drivingLicenseNewPseudoUrls,
        options: optionsForFiles,
        // distinct: user.id,
      })

      // 6. Préparer les données à sauvegarder/mettre à jour
      const dataToSave: Partial<UserDocument> & { user_id: string } = {
        user_id: user.id, // Lie toujours à l'utilisateur
        identity_document_images: finalIdentityUrls, // URLs retournées par updateFiles
        driving_license_images: finalLicenseUrls,
        // Convertit les dates si elles existent, sinon laisse null
        identity_document_expiry_date: identity_document_expiry_date
          ? DateTime.fromISO(identity_document_expiry_date)
          : null,
        driving_license_expiry_date: driving_license_expiry_date
          ? DateTime.fromISO(driving_license_expiry_date)
          : null,
        // Mettre à jour les métadonnées
        status: DocumentStatus.PENDING, // Repasse en PENDING à chaque soumission/mise à jour
        submitted_at: DateTime.now(),
        rejection_reason: null, // Efface l'ancienne raison de rejet
        verified_at: null, // Annule une éventuelle ancienne vérification
      }

      // 7. Créer ou Mettre à jour l'enregistrement UserDocument
      if (userDocument) {
        // Mise à jour
        userDocument.merge(dataToSave)
        await userDocument.save() // Pas besoin de passer trx ici, car on l'a trouvé avec trx
        logger.info(`UserDocument ${userDocument.id} mis à jour pour user ${user.id}`)
      } else {
        // Création
        userDocument = await UserDocument.create(
          { ...dataToSave, id: cuid() }, // Assure-toi que les champs obligatoires y sont
          { client: trx }
        )
        logger.info(`UserDocument ${userDocument.id} créé pour user ${user.id}`)

        // --- LIEN IMPORTANT : Met à jour Driver.user_document_id ---
        const driver = await Driver.findBy('id', user.id, { client: trx })
        if (!driver) {
          // Ne devrait pas arriver si l'onboarding a bien fonctionné
          throw new Error(`Enregistrement Driver non trouvé pour l'utilisateur ${user.id}`)
        }
        driver.user_document_id = userDocument.id
        await driver.save() // Pas besoin de trx non plus ici
        logger.info(`Driver ${driver.id} lié à UserDocument ${userDocument.id}`)
        // --- Fin LIEN ---
      }

      // 8. Commit Transaction
      await trx.commit()

      // 9. Réponse
      return response.ok({
        message: 'Documents soumis avec succès. Ils sont en attente de validation.',
        document: userDocument.serialize(),
      })
    } catch (error) {
      await trx.rollback()
      logger.error({ err: error, userId: user.id }, 'Erreur lors de la soumission/màj UserDocument')

      // Note : Il est difficile de faire un rollback propre des fichiers créés par updateFiles sans une gestion plus fine (RollbackManager suggéré précédemment)
      // On log l'erreur pour une éventuelle intervention manuelle sur les fichiers orphelins.

      if (error.code === 'E_VALIDATION_ERROR') {
        // Erreur venant du validateur (ne devrait pas arriver ici si bien géré avant)
        return response.badRequest({ errors: error.messages })
      }
      return response.internalServerError({
        message: 'Erreur lors de la soumission des documents.',
      })
    }
  }

  listDocumentsQueryValidator = vine.compile(
    vine.object({
      status: vine.enum(DocumentStatus).optional(), // Filtre optionnel par statut
      user_id: vine.string().uuid().optional(), // Filtre optionnel par ID de user (si besoin de voir les documents d'un user spécifique)
      page: vine.number().min(1).optional(), // Pour la pagination
      perPage: vine.number().min(1).max(100).optional(), // Pour la pagination (limite max)
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
      // --- Gestion Erreur admin_index ---
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
      ) // Valider AVANT
      const userDocument = await UserDocument.find(documentId, { client: trx }) // Trouver APRES validation

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

      // Mettre à jour User.is_valid_driver

      const driver = await Driver.query()
        .where('id', userDocument.driver_id)
        //@ts-ignore
        .preload('user')
        .first()
      if (!driver) {
        throw new Error(`Utilisateur ${userDocument.driver_id} non trouvé`)
      }
      driver.user.is_valid_driver = status === DocumentStatus.APPROVED
      await driver.user.save()
      logger.info(`Driver validity user ${driver.user_id} set to ${driver.user.is_valid_driver}`)

      // TODO: AuditLog, Notification

      await trx.commit() // Tout est OK, on commit

      logger.info(
        `Statut UserDocument ${documentId} (${oldStatus} -> ${status}) updated by admin ${adminUser.id}`
      )
      return response.ok({
        message: 'Statut du document mis à jour avec succès.',
        document: userDocument.serialize(),
      })
    } catch (error) {
      await trx.rollback() // Annuler TOUTES les opérations DB si erreur
      // --- Gestion Erreur admin_update_status ---
      logger.error(
        { err: error, documentId, adminId: adminUser.id },
        'Erreur MàJ statut document par admin'
      )

      if (error.code === 'E_VALIDATION_ERROR') {
        // Erreur du validateur (status invalide, raison manquante si rejet)
        return response.badRequest({
          message: 'Données de mise à jour invalides.',
          errors: error.messages,
        })
      }
      if (error.message.includes('Utilisateur') && error.message.includes('non trouvé')) {
        // Cas où l'utilisateur lié au document n'existe plus (rare mais possible)
        return response.internalServerError({
          message: "Erreur critique: l'utilisateur associé à ce document est introuvable.",
        })
      }
      // Autres erreurs (BDD, etc.)
      return response.internalServerError({
        message: 'Erreur serveur lors de la mise à jour du statut du document.',
      })
      // --- Fin Gestion Erreur ---
    }
  }
}
