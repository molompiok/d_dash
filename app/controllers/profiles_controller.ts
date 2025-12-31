import { deleteFiles } from '#services/media/DeleteFiles'
import { updateFiles } from '#services/media/UpdateFiles'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'

import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { RoleType } from '#models/user'
const phoneRule = vine
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{1,14}$/) // Format E.164 simplifié

export const profileValidator = vine.compile(
  vine.object({
    full_name: vine.string().trim().minLength(3).optional(), // Optionnel: on ne modifie que si fourni

    role: vine.enum(RoleType), // Optionnel: on ne modifie que si fourni
    // Mettre à jour la liste des téléphones
    phone: vine.array(phoneRule).optional(), // Le tableau entier remplace l'ancien

    // La photo est gérée comme pour UserDocument, mais une seule photo attendue
    photo: vine
      .file({
        size: '5mb',
        extnames: ['jpg', 'jpeg', 'png', 'webp'],
      })
      .optional(), // Fichier photo optionnel
    fcm_token: vine.string().optional(), // Optionnel: on ne modifie que si fourni

    // Champ "meta" si updateFiles est utilisé pour une seule photo
    _photoNewPseudoUrls: vine.string().optional(),

    // On ne permet PAS de changer le rôle ou le statut de validation ici.
  })
)
@inject()
export default class ProfileController {
  /**
   * Récupère les informations complètes du profil de l'utilisateur connecté.
   * GET /profile (la route existait déjà)
   */
  async me({ auth, response, request }: HttpContext) {
    // Le middleware 'auth' s'est déjà chargé de l'authentification
    const data = request.qs()
    logger.info({ data }, 'Données récupérées')
    await auth.check() // Force le chargement si ce n'est pas déjà fait
    // const role = await request.validateUsing()
    let role: RoleType

    try {
      role = await vine.compile(vine.enum(RoleType)).validate(data.role)
      logger.info({ role }, 'Rôle récupéré')
    } catch (error) {
      logger.error({ err: error }, 'Erreur récupération rôle utilisateur')
      return response.badRequest({ message: 'Paramètres de requête invalides.' })
    }

    logger.info({ role }, 'Rôle récupéré')
    const user = await auth.authenticate()

    try {
      // Charge les relations en fonction du rôle pour une réponse complète
      if (role === 'client') {
        await user.load('company', (query) => query.preload('subscription')) // Charger l'entreprise avec l'abonnement
      } else if (role === 'driver') {
        await user.load('driver', (query) => query.preload('vehicles').preload('user_document')) // Charger relations du driver
      }

      // Retourne l'utilisateur avec ses relations chargées, en omettant le mot de passe
      return response.ok(user.serialize({ fields: { omit: ['password'] } }))
    } catch (error) {
      logger.error({ err: error, userId: user.id }, 'Erreur récupération profil utilisateur')
      return response.internalServerError({ message: 'Erreur lors de la récupération du profil.' })
    }
  }

  async update({ auth, request, response }: HttpContext) {
    logger.info('Mise à jour du profil utilisateur')
    await auth.check()
    const user = await auth.authenticate()
    console.log('/************/', user);

    logger.debug('Utilisateur trouvé', { userId: user })
    const payload = await request.validateUsing(profileValidator)
    const photoFile = request.file('photo')

    let newPhotoUrl: string[] = user.photo
    let oldPhotoUrlToDeleteOnError: string | null = null

    const trx = await db.transaction()

    try {
      user.useTransaction(trx)

      // Mise à jour de la photo si un fichier est envoyé
      if (photoFile) {
        const updatedUrls = await updateFiles({
          request,
          table_id: user.id,
          table_name: 'users',
          column_name: 'photo',
          lastUrls: user.photo || [],
          newPseudoUrls: payload._photoNewPseudoUrls,
          options: {
            maxSize: 5 * 1024 * 1024,
            extname: ['jpg', 'jpeg', 'png', 'webp'],
          },
        })

        if (updatedUrls.length > 0) {
          newPhotoUrl = [updatedUrls[0]]
          if (!user.photo.includes(updatedUrls[0])) {
            oldPhotoUrlToDeleteOnError = updatedUrls[0]
          }
        }
      }

      // Mise à jour des champs simples
      if (payload.full_name !== undefined) {
        user.full_name = payload.full_name
      }
      if (payload.phone !== undefined) {
        user.phone = payload.phone
      }

      // Mise à jour du FCM Token en fonction du rôle
      if (payload.fcm_token !== undefined && payload.role) {
        if (payload.role === RoleType.CLIENT) {
          await user.load('company')
          user.company.useTransaction(trx)
          user.company.fcm_token = payload.fcm_token
          await user.company.save()
        } else if (payload.role === RoleType.DRIVER) {
          await user.load('driver')
          user.driver.useTransaction(trx)
          user.driver.fcm_token = payload.fcm_token
          await user.driver.save()
        }
      }

      user.photo = newPhotoUrl
      await user.save()

      await trx.commit()

      // Recharge la bonne relation après commit
      if (payload.role === RoleType.CLIENT) {
        await user.load('company')
      } else if (payload.role === RoleType.DRIVER) {
        await user.load('driver')
      }

      return response.ok({
        message: 'Profil mis à jour avec succès.',
        user: user.serialize({ fields: { omit: ['password'] } }),
      })
    } catch (error) {
      await trx.rollback()

      if (oldPhotoUrlToDeleteOnError) {
        logger.warn(`Rollback update profile for user ${user.id}, attempting to delete new file: ${oldPhotoUrlToDeleteOnError}`)
        try {
          await deleteFiles(user.id, 'photo')
        } catch (deleteError) {
          logger.error({ err: deleteError }, `Failed to delete photo after rollback for user ${user.id}`)
        }
      }

      logger.error({ err: error, userId: user.id }, 'Erreur mise à jour profil utilisateur')

      if (error.code === 'E_VALIDATION_ERROR') {
        logger.error({ err: error, userId: user.id }, 'Erreur validation mise à jour profil utilisateur')
        return response.badRequest({ errors: error.messages })
      }

      return response.internalServerError({ message: 'Erreur lors de la mise à jour du profil.' })
    }
  }

} // Fin du contrôleur
