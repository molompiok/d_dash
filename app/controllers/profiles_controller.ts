import { deleteFiles } from '#services/media/DeleteFiles'
import { updateFiles } from '#services/media/UpdateFiles'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import vine from '@vinejs/vine'

import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
const phoneRule = vine
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{1,14}$/) // Format E.164 simplifié

export const profileValidator = vine.compile(
  vine.object({
    full_name: vine.string().trim().minLength(3).optional(), // Optionnel: on ne modifie que si fourni

    // Mettre à jour la liste des téléphones
    phone: vine.array(phoneRule).optional(), // Le tableau entier remplace l'ancien

    // La photo est gérée comme pour UserDocument, mais une seule photo attendue
    photo: vine
      .file({
        size: '5mb',
        extnames: ['jpg', 'jpeg', 'png', 'webp'],
      })
      .optional(), // Fichier photo optionnel

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
  async me({ auth, response }: HttpContext) {
    // Le middleware 'auth' s'est déjà chargé de l'authentification
    await auth.check() // Force le chargement si ce n'est pas déjà fait
    const user = auth.getUserOrFail()

    try {
      // Charge les relations en fonction du rôle pour une réponse complète
      if (user.role === 'client') {
        await user.load('client', (query) => query.preload('subscription')) // Exemple : Charger aussi l'abonnement
      } else if (user.role === 'driver') {
        await user.load('driver', (query) => query.preload('vehicles').preload('user_document')) // Charger relations du driver
      }

      // Retourne l'utilisateur avec ses relations chargées, en omettant le mot de passe
      return response.ok(user.serialize({ fields: { omit: ['password'] } }))
    } catch (error) {
      logger.error({ err: error, userId: user.id }, 'Erreur récupération profil utilisateur')
      return response.internalServerError({ message: 'Erreur lors de la récupération du profil.' })
    }
  }

  /**
   * Met à jour les informations du profil de l'utilisateur connecté.
   * PATCH /profile ou PUT /profile
   */
  async update({ auth, request, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()

    // Valide les données reçues pour la mise à jour
    // Le validateur n'échoue que si un champ fourni est invalide.
    // Les champs absents ne causent pas d'erreur car 'optional()'
    const payload = await request.validateUsing(profileValidator)
    const photoFile = request.file('photo') // Récupère le fichier s'il existe

    let newPhotoUrl: string[] = user.photo // Garde l'ancienne par défaut
    let oldPhotoUrlToDeleteOnError: string | null = null // Pour le rollback fichier

    // Transaction pour la mise à jour et potentiellement le fichier
    const trx = await db.transaction()

    try {
      // 1. Mettre à jour la photo si un nouveau fichier est fourni
      if (photoFile) {
        const options = {
          maxSize: 5 * 1024 * 1024,
          extnames: ['jpg', 'jpeg', 'png', 'webp'],
        }

        // updateFiles retourne un tableau, même pour un seul fichier
        const updatedUrls = await updateFiles({
          request: request,
          table_id: user.id,
          table_name: 'users',
          column_name: 'photo',
          lastUrls: user.photo || [], // Anciennes URLs photo (normalement une seule)
          newPseudoUrls: payload._photoNewPseudoUrls, // Si vous utilisez cette approche
          options: options,
        })

        // Prend la première URL retournée s'il y en a une
        if (updatedUrls.length > 0) {
          newPhotoUrl = [updatedUrls[0]] // Met à jour la nouvelle URL (en tableau)
          // Mémorise l'URL créée pour la supprimer en cas de rollback DB
          // Note: Ceci est une simplification. Un RollbackManager serait plus robuste.
          if (!user.photo.includes(updatedUrls[0])) {
            // Si c'est réellement une *nouvelle* photo
            oldPhotoUrlToDeleteOnError = updatedUrls[0]
          }
        } else {
          // Si updateFiles ne retourne rien (erreur silencieuse ?), on garde l'ancienne
          newPhotoUrl = user.photo
        }
      }

      // 2. Mettre à jour les champs de l'utilisateur dans la transaction
      // On ne merge que les champs qui existent dans le payload validé
      user.useTransaction(trx) // Applique la transaction à l'objet user existant
      if (payload.full_name !== undefined) user.full_name = payload.full_name
      if (payload.phone !== undefined) user.phone = payload.phone
      user.photo = newPhotoUrl // Applique la nouvelle (ou ancienne) URL de photo

      await user.save() // Sauvegarde les modifications utilisateur dans la transaction

      // 3. Commit la transaction
      await trx.commit()

      // Charge à nouveau les relations pour la réponse (car elles pourraient avoir changé)
      if (user.role === 'client') await user.load('client')
      if (user.role === 'driver') await user.load('driver')

      // 4. Réponse
      return response.ok({
        message: 'Profil mis à jour avec succès.',
        user: user.serialize({ fields: { omit: ['password'] } }),
      })
    } catch (error) {
      await trx.rollback()

      // Tentative de suppression de la nouvelle photo si créée pendant la transaction échouée
      if (oldPhotoUrlToDeleteOnError) {
        logger.warn(
          `Rollback update profile for user ${user.id}, attempting to delete new file: ${oldPhotoUrlToDeleteOnError}`
        )
        try {
          // Ici, deleteFiles aurait besoin de l'URL ou d'un identifiant pour fonctionner
          await deleteFiles(user.id, 'photo') // Utilise le nom de champ et ID user
        } catch (deleteError) {
          logger.error(
            { err: deleteError },
            `Failed to delete photo after rollback for user ${user.id}`
          )
        }
      }

      logger.error({ err: error, userId: user.id }, 'Erreur mise à jour profil utilisateur')
      if (error.code === 'E_VALIDATION_ERROR') {
        return response.badRequest({ errors: error.messages })
      }
      return response.internalServerError({ message: 'Erreur lors de la mise à jour du profil.' })
    }
  }
} // Fin du contrôleur
