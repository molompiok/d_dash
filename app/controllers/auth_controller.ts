/* eslint-disable @typescript-eslint/naming-convention */
import vine from '@vinejs/vine'
import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import Client from '#models/client'
import Driver from '#models/driver'
import { RoleType } from '#models/user' // Assure-toi que cet enum est correct
import { cuid } from '@adonisjs/core/helpers' // Pour ID uniques
import logger from '@adonisjs/core/services/logger'

export const registerUserValidator = vine.compile(
  vine.object({
    full_name: vine.string().trim().minLength(3),
    email: vine.string().email(),
    password: vine.string().minLength(8),
    phone: vine.array(vine.string().trim()),
    photo: vine
      .file({
        size: '5mb', // Ajuste la taille max
        extnames: ['jpg', 'jpeg', 'png', 'webp', 'gif'], // Ajuste les extensions
      })
      .optional(), // Rend le champ photo optionnel
  })
)

export const registerDriverValidator = vine.compile(
  vine.object({
    full_name: vine.string().trim().minLength(3),
    email: vine.string().email(),
    password: vine.string().minLength(8),
    phone: vine.array(vine.string().trim()),
  })
)

export const googleSignInValidator = vine.compile(
  vine.object({
    idToken: vine.string().trim(),
  })
)

export const loginValidator = vine.compile(
  vine.object({
    email: vine.string().email(),
    password: vine.string().minLength(8),
  })
)

// Validateurs
// import { registerUserValidator } from '#validators/auth/register_user_validator'
// import { registerDriverValidator } from '#validators/auth/register_driver_validator'
// import { loginValidator } from '#validators/auth/login_validator'
// import { googleSignInValidator } from '#validators/auth/google_sign_in_validator'

// Google Auth
import { OAuth2Client, TokenPayload } from 'google-auth-library'
import env from '#start/env'
import { createFile } from '#services/media/CreateFiles'
import { deleteFiles } from '#services/media/DeleteFiles'

@inject()
export default class AuthController {
  // Initialise le client Google Auth une seule fois
  private googleClient = new OAuth2Client(env.get('GOOGLE_CLIENT_ID'))

  /**
   * Enregistre un nouvel utilisateur de type Client.
   * POST /register_user
   */
  async register_user({ request, response }: HttpContext) {
    let profilePhotoUrl: string | null | undefined = null
    let newUser: User | null = null

    // Valide les données et le fichier photo optionnel
    const { email, password, full_name, phone } = await request.validateUsing(registerUserValidator)
    const photoFile = request.file('photo') // Récupère le fichier après validation

    const trx = await db.transaction() // Démarre la transaction

    try {
      // Crée l'utilisateur
      newUser = await User.create(
        {
          id: cuid(), // Génère un ID CUID
          email,
          password, // Le mot de passe sera hashé par le hook du modèle ou Hash.make()
          full_name,
          phone: phone || [],
          role: RoleType.CLIENT,
          is_valid_client: true, // Un nouveau client est valide par défaut
          is_valid_driver: false,
          photo: [], // Initialise vide, sera mis à jour si photo fournie
        },
        { client: trx } // Utilise la transaction
      )

      // Crée le client associé
      await Client.create(
        {
          id: cuid(),
          user_id: newUser.id,
          api_key: `secret_${cuid()}`, // Génère une clé API simple
          order_count: 0,
          // Assigne un subscription_id par défaut ou null si géré ailleurs
          subscription_id: cuid(), // A CHANGER: Mettre l'ID d'une souscription par défaut si nécessaire
        },
        { client: trx }
      )

      // Traite le fichier photo si fourni
      if (photoFile && newUser) {
        profilePhotoUrl = await createFile({
          request, // Doit être l'instance complète HttpContext.request
          file: photoFile,
          table_id: newUser.id,
          table_name: 'users', // Nom de la table
          column_name: 'photo', // Nom de la colonne
          options: { maxSize: 5 * 1024 * 1024, compress: 'img' }, // Limite à 5MB
        })

        if (profilePhotoUrl) {
          newUser.photo = [profilePhotoUrl]
          await newUser.save() // Sauvegarde l'URL de la photo dans la transaction
        }
      }

      // Génère le token d'accès
      const token = await User.accessTokens.create(newUser)

      await trx.commit() // Valide la transaction

      return response.created({
        user: newUser.serialize(), // Ne pas renvoyer le mot de passe hashé
        token: token.value!.release(), // Renvoie seulement la valeur du token
      })
    } catch (error) {
      await trx.rollback() // Annule la transaction en cas d'erreur

      // Si une photo a été créée avant le rollback, on essaie de la supprimer
      if (profilePhotoUrl && newUser?.id) {
        logger.warn(
          `Rollback après création utilisateur ${newUser.id}, tentative de suppression fichier: ${profilePhotoUrl}`
        )
        try {
          // Tente de supprimer en utilisant l'ID utilisateur car l'URL peut varier
          await deleteFiles(newUser.id, 'photo') // Précise le fieldName
        } catch (deleteError) {
          logger.error(
            { err: deleteError },
            `Echec de suppression fichier après rollback pour user ${newUser.id}`
          )
        }
      }

      logger.error({ err: error }, "Erreur lors de l'enregistrement utilisateur (client)")
      return response.badRequest({ message: "Erreur lors de l'inscription", error: error.message })
    }
  }

  /**
   * Enregistre un nouvel utilisateur de type Driver.
   * POST /register_driver
   */
  async register_driver({ request, response }: HttpContext) {
    let profilePhotoUrl: string | null | undefined = null
    let newUser: User | null = null

    // Valide les données et le fichier photo optionnel
    const { email, password, full_name, phone } =
      await request.validateUsing(registerDriverValidator)
    const photoFile = request.file('photo')

    const trx = await db.transaction()

    try {
      // Crée l'utilisateur Driver
      newUser = await User.create(
        {
          id: cuid(),
          email,
          password,
          full_name,
          phone: phone || [],
          role: RoleType.DRIVER,
          is_valid_client: false, // Un nouveau driver n'est pas client par défaut
          is_valid_driver: false, // !! Un nouveau driver N'EST PAS valide avant vérification doc
          photo: [],
        },
        { client: trx }
      )

      // Crée le Driver associé
      await Driver.create(
        {
          id: cuid(),
          user_id: newUser.id, // Utilise le même ID que l'utilisateur par convention
          user_document_id: undefined, // Sera lié plus tard lors de l'upload des docs
          average_rating: 0, // Note initiale
          delivery_stats: { success: 0, failure: 0, total: 0 }, // Stats initiales
        },
        { client: trx }
      )

      // Traite la photo de profil si fournie
      if (photoFile && newUser) {
        profilePhotoUrl = await createFile({
          request,
          file: photoFile,
          table_id: newUser.id,
          table_name: 'users',
          column_name: 'photo',
          options: { maxSize: 5 * 1024 * 1024 },
        })
        if (profilePhotoUrl) {
          newUser.photo = [profilePhotoUrl]
          await newUser.save()
        }
      }

      // Génère le token
      const token = await User.accessTokens.create(newUser)

      await trx.commit()

      return response.created({
        user: newUser.serialize(),
        token: token.value!.release(),
      })
    } catch (error) {
      await trx.rollback()

      // Suppression photo si créée avant rollback
      if (profilePhotoUrl && newUser?.id) {
        logger.warn(
          `Rollback après création driver ${newUser.id}, tentative de suppression fichier: ${profilePhotoUrl}`
        )
        try {
          await deleteFiles(newUser.id, 'photo')
        } catch (deleteError) {
          logger.error(
            { err: deleteError },
            `Echec de suppression fichier après rollback pour driver ${newUser.id}`
          )
        }
      }

      logger.error({ err: error }, "Erreur lors de l'enregistrement utilisateur (driver)")
      return response.badRequest({
        message: "Erreur lors de l'inscription du livreur",
        error: error.message,
      })
    }
  }

  /**
   * Connecte un utilisateur (Client ou Driver) via email/password.
   * POST /login
   */
  async login({ request, response }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)

    try {
      // Vérifie les credentials
      const user = await User.verifyCredentials(email, password)

      if (user.role === RoleType.CLIENT && !user.is_valid_client) {
        // return response.unauthorized({ message: "Votre compte client n'est pas actif." })
      }
      if (user.role === RoleType.DRIVER && !user.is_valid_driver) {
        // Message spécifique pour le driver en attente
        // return response.unauthorized({
        //   message: 'Votre compte livreur est en attente de validation ou a été désactivé.',
        // })
      }

      // Génère un token
      const token = await User.accessTokens.create(user)

      // Charge la relation correspondante au rôle pour l'inclure dans la réponse
      if (user.role === RoleType.CLIENT) await user.load('client')
      if (user.role === RoleType.DRIVER) await user.load('driver')

      return response.ok({
        user: user.serialize({
          fields: { omit: ['password', 'remember_me_token'] }, // Omettre explicitement le mot de passe
        }),
        token: token.value!.release(),
      })
    } catch (error) {
      logger.warn({ err: error }, `Échec de connexion pour ${email}`)
      if (error.code === 'E_INVALID_CREDENTIALS') {
        return response.unauthorized({ message: 'Email ou mot de passe incorrect.' })
      }
      return response.badRequest({ message: 'Erreur lors de la connexion', error: error.message })
    }
  }

  /**
   * Gère la connexion/inscription via Google One Tap.
   * POST /auth/google/callback
   */
  async handle_google_sign_in({ request, response }: HttpContext) {
    const { idToken } = await request.validateUsing(googleSignInValidator)
    let payload: TokenPayload | undefined

    try {
      // Vérifie le token ID auprès de Google
      const ticket = await this.googleClient.verifyIdToken({
        idToken: idToken,
        audience: env.get('GOOGLE_CLIENT_ID'),
      })
      payload = ticket.getPayload()

      if (!payload || !payload.email || !payload.sub) {
        throw new Error('Payload Google invalide ou manquant.')
      }

      const trx = await db.transaction() // Transaction pour potentielle création/mise à jour
      let user: User | null = null
      let isNewUser = false

      try {
        // 1. Chercher par Google ID
        user = await User.query({ client: trx }).where('google_id', payload.sub).first()

        if (!user) {
          // 2. Si non trouvé, chercher par email
          user = await User.query({ client: trx }).where('email', payload.email).first()

          if (user) {
            // Utilisateur trouvé par email -> Lier le compte Google
            user.google_id = payload.sub
            // Met à jour la photo si l'utilisateur n'en a pas et Google en fournit une
            if (user.photo.length === 0 && payload.picture) {
              user.photo = [payload.picture] // Utilise l'URL de Google directement
            }
            await user.save()
          } else {
            // 3. Ni Google ID, ni Email -> Nouvel utilisateur (sera Client par défaut)
            isNewUser = true
            const randomPassword = cuid() + cuid() // Génère un mdp aléatoire fort
            user = await User.create(
              {
                id: cuid(),
                email: payload.email,
                password: randomPassword, // Requis par le modèle, même si connexion Google
                full_name: payload.name || 'Utilisateur Google',
                google_id: payload.sub,
                role: RoleType.CLIENT, // Nouvel utilisateur via Google = Client par défaut
                is_valid_client: true, // Nouveau client via Google est valide
                is_valid_driver: false,
                photo: payload.picture ? [payload.picture] : [], // Photo Google si dispo
              },
              { client: trx }
            )

            // Crée le client associé
            await Client.create(
              {
                id: cuid(),
                user_id: user.id,
                api_key: `secret_${cuid()}`,
                order_count: 0,
                subscription_id: cuid(), // A CHANGER: ID souscription par défaut
              },
              { client: trx }
            )
          }
        }

        // --- Vérification de la validité basée sur le rôle pour connexion ---
        if (user.role === RoleType.CLIENT && !user.is_valid_client) {
          // Ne devrait pas arriver si créé comme valide, mais sécurité
          // throw new Error('Compte client inactif.')
        }
        if (user.role === RoleType.DRIVER && !user.is_valid_driver) {
          // Cas où un driver existant non-validé tente de se connecter via Google
          // throw new Error('Compte livreur en attente de validation ou désactivé.')
        }

        // Génère le token pour l'utilisateur trouvé ou créé
        const token = await User.accessTokens.create(user)

        await trx.commit() // Valide la transaction

        // Charge la relation client si c'est pertinent
        if (user.role === RoleType.CLIENT) await user.load('client')

        const responseData = {
          user: user.serialize({ fields: { omit: ['password', 'remember_me_token'] } }),
          token: token.value!.release(),
        }

        if (isNewUser) {
          return response.created(responseData)
        } else {
          return response.ok(responseData)
        }
      } catch (dbError) {
        await trx.rollback() // Rollback spécifique à l'intérieur du bloc principal
        throw dbError // Relance l'erreur pour le catch externe
      }
    } catch (error) {
      logger.error({ err: error, google_payload: payload }, 'Erreur lors de la connexion Google')
      return response.badRequest({
        message: 'Erreur lors de la connexion Google',
        error: error.message,
      })
    }
  }

  /**
   * Permet à un utilisateur connecté (généralement un Client)
   * de démarrer le processus pour devenir Driver.
   * POST /driver/start_onboarding (nécessite middleware auth)
   */
  async start_driver_onboarding({ auth, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()

    // Vérifier si l'utilisateur n'est pas déjà un Driver (ou déjà en cours ?)
    if (user.role === RoleType.DRIVER) {
      return response.badRequest({ message: 'Vous êtes déjà enregistré comme livreur.' })
    }

    const trx = await db.transaction()
    try {
      // Option 1: Changer le rôle de l'utilisateur
      user.role = RoleType.DRIVER
      // On NE le valide PAS encore comme driver
      user.is_valid_driver = false
      // Décision : est-ce qu'il perd son statut de client valide ? (Supposons que non ici)
      // user.is_valid_client = false; // -> Si nécessaire
      await user.useTransaction(trx).save()

      // Vérifier/Créer l'enregistrement Driver associé
      let driver = await Driver.find(user.id, { client: trx })
      if (!driver) {
        await Driver.create(
          {
            id: user.id, // Utilise le même ID
            user_document_id: undefined,
            average_rating: 0,
            delivery_stats: { success: 0, failure: 0, total: 0 },
          },
          { client: trx }
        )
      }

      // TODO: Optionnellement, créer un enregistrement UserDocument vide/en attente ici ?
      // Ou laisser l'upload déclencher sa création.

      await trx.commit()

      // Retourner un message indiquant la prochaine étape
      return response.ok({
        message:
          'Processus pour devenir livreur initié. Veuillez maintenant soumettre vos documents.',
        user: user.serialize({ fields: { omit: ['password'] } }), // Renvoie l'utilisateur mis à jour
      })
    } catch (error) {
      await trx.rollback()
      logger.error(
        { err: error, userId: user.id },
        "Erreur lors du démarrage de l'onboarding livreur"
      )
      return response.internalServerError({ message: 'Une erreur est survenue.' })
    }
  }

  /**
   * Déconnecte l'utilisateur en révoquant le token actuel.
   * POST /logout (nécessite middleware auth)
   */
  async logout({ auth, response }: HttpContext) {
    // Assure que l'utilisateur est authentifié via le middleware auth
    await auth.check()
    const user = auth.getUserOrFail()

    // Récupère l'identifiant du token actuel utilisé pour la requête
    const tokenId = user.currentAccessToken?.identifier

    if (!tokenId) {
      // Ne devrait pas arriver si le middleware auth est utilisé
      return response.badRequest({ message: 'Impossible de trouver le token actuel.' })
    }

    try {
      // Révoque le token spécifique utilisé
      await User.accessTokens.delete(user, tokenId)
      return response.ok({ message: 'Déconnexion réussie.' })
    } catch (error) {
      logger.error(
        { err: error, userId: user.id },
        'Erreur lors de la révocation du token de déconnexion'
      )
      return response.internalServerError({ message: 'Erreur lors de la déconnexion.' })
    }
  }

  /**
   * Récupère le profil de l'utilisateur authentifié.
   * GET /profile (nécessite middleware auth)
   */
  async profile({ auth, response }: HttpContext) {
    await auth.check()
    const user = auth.getUserOrFail()

    // Charge les relations pertinentes selon le rôle
    if (user.role === RoleType.CLIENT) {
      await user.load('client', (clientQuery) => {
        // Charger la souscription du client si besoin
        clientQuery.preload('subscription')
      })
    } else if (user.role === RoleType.DRIVER) {
      await user.load('driver', (driverQuery) => {
        // Charger les véhicules ou les documents si besoin
        driverQuery.preload('vehicles').preload('user_document')
      })
      // Optionnel : Charger aussi les documents directement sur l'utilisateur
      // await user.load('documents')
    }

    return response.ok(user.serialize({ fields: { omit: ['password', 'remember_me_token'] } }))
  }
}
