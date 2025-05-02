/* eslint-disable @typescript-eslint/naming-convention */
import vine from '@vinejs/vine'
import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import Client from '#models/client'
import Driver from '#models/driver'
import { RoleType } from '#models/user' // Assurez-vous que cet enum est correct
import logger from '@adonisjs/core/services/logger'
import hash from '@adonisjs/core/services/hash'
import string from '@adonisjs/core/helpers/string' // <- Importé
import { DateTime } from 'luxon' // <- Importé

// Google Auth
import { OAuth2Client, TokenPayload } from 'google-auth-library'
import env from '#start/env'

// Custom Services (Assurez-vous que les chemins sont corrects)
import { createFile } from '#services/media/CreateFiles'
import { deleteFiles } from '#services/media/DeleteFiles'

// --- Validateurs ---
// (Il est généralement préférable de les mettre dans des fichiers séparés sous app/validators,
// mais les garder ici fonctionne aussi pour un exemple)

export const registerUserValidator = vine.compile(
  vine.object({
    full_name: vine.string().trim().minLength(3),
    email: vine.string().email().normalizeEmail(), // Bonne pratique d'ajouter normalizeEmail
    password: vine.string().minLength(8),
    phone: vine.array(vine.string().trim()).optional(), // Rendre phone optionnel explicitement si c'est le cas
    photo: vine
      .file({
        size: '5mb',
        extnames: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      })
      .optional(),
  })
)

export const registerDriverValidator = vine.compile(
  vine.object({
    full_name: vine.string().trim().minLength(3),
    email: vine.string().email().normalizeEmail(),
    password: vine.string().minLength(8),
    phone: vine.array(vine.string().trim()).optional(),
    photo: vine // Ajout de la photo optionnelle ici aussi si nécessaire pour les drivers
      .file({
        size: '5mb',
        extnames: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      })
      .optional(),
  })
)

export const googleSignInValidator = vine.compile(
  vine.object({
    idToken: vine.string().trim(),
    role: vine.enum([RoleType.CLIENT, RoleType.DRIVER]),
  })
)

export const loginValidator = vine.compile(
  vine.object({
    email: vine.string().email().normalizeEmail(),
    password: vine.string().minLength(8), // Garder minLength cohérent
    role: vine.enum([RoleType.CLIENT, RoleType.DRIVER]),
  })
)

// --- Controller ---

@inject()
export default class AuthController {
  // Initialise le client Google Auth une seule fois
  private googleClient = new OAuth2Client(env.get('GOOGLE_CLIENT_ID'))

  /**
   * Méthode privée pour créer un token manuellement dans une transaction.
   * Retourne la valeur brute du token.
   */
  // private async _createTokenManually(
  //   user: User,
  //   trx: any,
  //   tokenName: string = 'auth_token' // Permet de personnaliser le nom
  // ): Promise<string> {
  //   logger.debug(`Début création manuelle token pour user ${user.id} (dans TRX)`)
  //   const rawTokenValue = string.generateRandom(60)
  //   const tokenHash = await hash.make(rawTokenValue)
  //   const now = DateTime.now()
  //   const abilities = JSON.stringify(['*']) // Ou des abilities spécifiques si nécessaire
  //   const tokenType = 'bearer' // Ou 'api_token' selon votre garde auth

  //   try {
  //     await trx
  //       .insertQuery()
  //       .table('auth_access_tokens')
  //       .insert({
  //         tokenable_id: user.id,
  //         type: tokenType,
  //         name: tokenName,
  //         hash: tokenHash,
  //         abilities: abilities,
  //         created_at: now,
  //         updated_at: now,
  //         expires_at: now.plus({ days: 30 }) // Décommenter pour ajouter une expiration
  //       })
  //     logger.info(`Token inséré manuellement pour user ${user.id} (dans TRX)`)
  //     return rawTokenValue
  //   } catch (dbError) {
  //     logger.error(
  //       { err: dbError, userId: user.id },
  //       'Erreur DB lors de l\'insertion manuelle du token'
  //     )
  //     // Relance l'erreur pour qu'elle soit capturée par le bloc catch externe et déclenche le rollback
  //     throw dbError
  //   }
  // }

  /**
   * Enregistre un nouvel utilisateur de type Client.
   * POST /register_user
   */
  async register_user({ request, response }: HttpContext) {
    logger.info('Début register_user', request.all())
    let profilePhotoUrl: string | null | undefined = null
    let newUser: User | null = null

    const { email, password, full_name, phone } = await request.validateUsing(registerUserValidator)
    const photoFile = request.file('photo')

    const trx = await db.transaction()

    try {
      logger.debug(`Début transaction register_user pour ${email}`)
      // 1. Crée l'utilisateur
      newUser = await User.create(
        {
          // L'ID est généré par le hook beforeCreate
          email,
          password, // Sera hashé par le hook beforeSave/beforeCreate du modèle User
          full_name,
          phone: phone || [],
          // role: RoleType.CLIENT,
          photo: [],
        },
        { client: trx }
      )
      logger.info(`User ${newUser.id} (${email}) créé (dans TRX)`)

      // 2. Crée le client associé
      // Note: Envisager d'utiliser user_id comme clé primaire pour Client si la relation est 1-1
      await Client.create(
        {
          user_id: newUser.id,
          // Génération ID pour Client si pas 1-1 avec User
          // id: cuid(),
          api_key: `secret_${string.generateRandom(32)}`, // Clé API plus robuste
          order_count: 0,
          is_valid_client: true, // Client valide par défaut à l'inscription
          // subscription_id: ID_SOUSCRIPTION_PAR_DEFAUT, // A adapter selon votre logique
        },
        { client: trx }
      )
      logger.info(`Client associé créé pour user ${newUser.id} (dans TRX)`)

      // 3. Traite le fichier photo si fourni
      if (photoFile && newUser) {
        logger.debug(`Traitement photo pour user ${newUser.id}`)
        profilePhotoUrl = await createFile({
          request,
          file: photoFile,
          table_id: newUser.id,
          table_name: 'users',
          column_name: 'photo',
          options: { maxSize: 5 * 1024 * 1024 /*, compress: 'img'*/ }, // Vérifiez l'option compress
        })

        if (profilePhotoUrl) {
          newUser.photo = [profilePhotoUrl]
          await newUser.useTransaction(trx).save() // Sauvegarde l'URL dans la transaction
          logger.info(`Photo sauvegardée pour user ${newUser.id} (dans TRX)`)
        }
      }

      // 4. Crée le token d'accès manuellement DANS LA TRANSACTION
      
      // 5. Valide la transaction
      await trx.commit()
      const token = await User.accessTokens.create(newUser, ['*'], {
        name: 'auth_via_register_user',
        expiresIn: 30 * 24 * 60 * 60, // 30 jours
      })
      logger.info(`Transaction commitée pour register_user ${newUser.id}`)

      // Recharge l'utilisateur pour être sûr d'avoir toutes les données à jour
      const finalUser = await User.findOrFail(newUser.id)
      logger.info(`User ${newUser.id} rechargé`)
      await finalUser.load('client') // Charger la relation client

      return response.created({
        user: finalUser.serialize(),
        token: token.value?.release(), // Retourne la valeur brute
      })
    } catch (error) {
      logger.error({ err: error, email }, 'Erreur lors de register_user')
      // Rollback si la transaction n'est pas déjà terminée
      if (!trx.isCompleted) {
        await trx.rollback()
        logger.warn(`Transaction rollbackée pour register_user ${email}`)
      }

      // Suppression photo si créée avant rollback
      if (profilePhotoUrl && newUser?.id) {
        logger.warn(
          `Rollback register_user ${newUser.id}, tentative suppression fichier: ${profilePhotoUrl}`
        )
        try {
          await deleteFiles(newUser.id, 'photo')
        } catch (deleteError) {
          logger.error(
            { err: deleteError },
            `Echec suppression fichier post-rollback pour user ${newUser.id}`
          )
        }
      }

      // Gérer les erreurs spécifiques (ex: violation unicité email)
      if (error.code === '23505') { // Code PostgreSQL pour violation unique
        return response.conflict({ message: 'Un compte existe déjà avec cet email.' })
      }

      return response.badRequest({
        message: "Erreur lors de l'inscription",
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      })
    }
  }

  /**
   * Enregistre un nouvel utilisateur de type Driver.
   * POST /register_driver
   */
  async register_driver({ request, response }: HttpContext) {
    let profilePhotoUrl: string | null | undefined = null
    let newUser: User | null = null

    const { email, password, full_name, phone } =
      await request.validateUsing(registerDriverValidator)
    const photoFile = request.file('photo') // Récupère après validation

    const trx = await db.transaction()

    try {
      logger.debug(`Début transaction register_driver pour ${email}`)
      // 1. Crée l'utilisateur Driver
      newUser = await User.create(
        {
          email,
          password,
          full_name,
          phone: phone || [],
          // role: RoleType.DRIVER,
          photo: [],
        },
        { client: trx }
      )
      logger.info(`User ${newUser.id} (Driver, ${email}) créé (dans TRX)`)

      // 2. Crée le Driver associé
      await Driver.create(
        {
          user_id: newUser.id, // Utilise l'ID du newUser créé
          // id: cuid(), // Si clé primaire séparée
          average_rating: 0,
          is_valid_driver: false, // Non valide par défaut, nécessite onboarding/validation admin
          delivery_stats: { success: 0, failure: 0, total: 0 }, // Assurez-vous que c'est bien du JSON si type colonne = json/jsonb
        },
        { client: trx }
      )
      logger.info(`Driver associé créé pour user ${newUser.id} (dans TRX)`)

      // 3. Traite la photo de profil si fournie
      if (photoFile && newUser) {
        logger.debug(`Traitement photo pour driver ${newUser.id}`)
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
          await newUser.useTransaction(trx).save()
          logger.info(`Photo sauvegardée pour driver ${newUser.id} (dans TRX)`)
        }
      }

      // 4. Crée le token d'accès manuellement DANS LA TRANSACTION
      
      // 5. Commit la transaction
      await trx.commit()
      const token = await User.accessTokens.create(newUser, ['*'], {
        name: 'auth_via_register_driver',
        expiresIn: 30 * 24 * 60 * 60, // 30 jours
      })
      logger.info(`Transaction commitée pour register_driver ${newUser.id}`)

      // Recharge l'utilisateur final avec sa relation driver
      const finalUser = await User.findOrFail(newUser.id)
      await finalUser.load('driver')

      return response.created({
        user: finalUser.serialize(),
        token: token.value?.release(),
      })
    } catch (error) {
      logger.error({ err: error, email }, 'Erreur lors de register_driver')
      if (!trx.isCompleted) {
        await trx.rollback()
        logger.warn(`Transaction rollbackée pour register_driver ${email}`)
      }

      // Suppression photo si créée avant rollback
      if (profilePhotoUrl && newUser?.id) {
        logger.warn(
          `Rollback register_driver ${newUser.id}, tentative suppression fichier: ${profilePhotoUrl}`
        )
        try {
          await deleteFiles(newUser.id, 'photo')
        } catch (deleteError) {
          logger.error(
            { err: deleteError },
            `Echec suppression fichier post-rollback pour driver ${newUser.id}`
          )
        }
      }

      if (error.code === '23505') {
        return response.conflict({ message: 'Un compte existe déjà avec cet email.' })
      }

      return response.badRequest({
        message: "Erreur lors de l'inscription du livreur",
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      })
    }
  }

  /**
   * Connecte un utilisateur (Client ou Driver) via email/password.
   * POST /login
   */
  async login({ request, response }: HttpContext) {
    const { email, password, role } = await request.validateUsing(loginValidator)

    try {
      // 1. Vérifie les credentials (gère le hashage et la comparaison)
      const user = await User.verifyCredentials(email, password)
      logger.info(`Connexion réussie pour user ${user.id} (${email})`)

      // 2. Vérification additionnelle (optionnelle, dépend de la logique métier)
      // if (user.role === RoleType.CLIENT && !user.client?.is_valid_client) { // Charger la relation avant
      //    await user.load('client')
      //    if(!user.client?.is_valid_client) {
      //       logger.warn(`Tentative connexion client non valide: ${user.id}`)
      //       return response.unauthorized({ message: "Votre compte client n'est pas actif." })
      //    }
      // }
      // if (user.role === RoleType.DRIVER && !user.driver?.is_valid_driver) {
      //    await user.load('driver')
      //    if(!user.driver?.is_valid_driver) {
      //       logger.warn(`Tentative connexion driver non valide: ${user.id}`)
      //       return response.unauthorized({ message: 'Votre compte livreur est en attente de validation ou désactivé.' })
      //    }
      // }

      // 3. Génère un token (hors transaction, l'utilisateur existe déjà)
      // Ici, on peut utiliser la méthode standard car il n'y a pas de conflit de transaction
      const token = await User.accessTokens.create(user, ['*'], { name: 'auth_via_login' }) // On peut passer des abilities et options
      logger.info(`Token généré pour login user ${user.id}`)


      // 4. Charge la relation correspondante au rôle pour l'inclure dans la réponse
      if (role === RoleType.CLIENT) await user.load('client')
      if (role === RoleType.DRIVER) await user.load('driver')

      return response.ok({
        user: user.serialize({
          fields: { omit: ['password', 'remember_me_token'] },
        }),
        token: token.value!.release(), // Utiliser release() pour obtenir la string
      })
    } catch (error) {
      if (error.code === 'E_INVALID_CREDENTIALS') {
        logger.warn(`Échec de connexion (mauvais credentials) pour ${email}`)
        return response.unauthorized({ message: 'Email ou mot de passe incorrect.' })
      }
      logger.error({ err: error, email }, 'Erreur inattendue lors du login')
      return response.internalServerError({ // Préférer internalServerError pour les erreurs non prévues
        message: 'Erreur lors de la connexion',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      })
    }
  }

  /**
   * Gère la connexion/inscription via Google One Tap.
   * POST /auth/google/callback
   */
  async handle_google_sign_in({ request, response }: HttpContext) {
    const { idToken, role } = await request.validateUsing(googleSignInValidator)
    let payload: TokenPayload | undefined
    let user: User | null = null; // Déclarer user ici pour accès dans le catch externe
    let isNewUser = false;
    const webClientId = env.get('GOOGLE_WEB_CLIENT_ID');
    const androidClientId = env.get('GOOGLE_CLIENT_ID');

    // Assurez-vous qu'au moins le Web Client ID est défini
    if (!webClientId) {
      logger.fatal('GOOGLE_WEB_CLIENT_ID is not set in environment variables!');
      // Gérez l'erreur - arrêt du serveur ou configuration par défaut impossible ?
      throw new Error('Configuration Google Web Client ID manquante côté serveur.');
    }
    const validAudiences = [webClientId];
    if (androidClientId) {
      validAudiences.push(androidClientId); // Ajoutez l'Android ID si défini et potentiellement utile
    }
    try {
      // 1. Vérifie le token ID auprès de Google
      logger.debug('Vérification Google ID token...')
      const ticket = await this.googleClient.verifyIdToken({
        idToken: idToken,
        audience: validAudiences,
      })
      payload = ticket.getPayload()

      console.log('Payload Google:', payload);


      if (!payload || !payload.email || !payload.sub) {
        logger.error({ payload }, 'Payload Google invalide ou manquant.')
        throw new Error('Payload Google invalide ou manquant.')
      }
      logger.info(`Payload Google reçu pour ${payload.email} (sub: ${payload.sub})`)

      // --- Début Transaction pour création/mise à jour utilisateur ---
      const trx = await db.transaction()
      try {
        // 2. Chercher par Google ID
        logger.debug(`Recherche user par google_id: ${payload.sub}`)
        user = await User.query({ client: trx }).where('google_id', payload.sub).first()

        if (!user) {
          // 3. Si non trouvé, chercher par email
          logger.debug(`Non trouvé par google_id, recherche par email: ${payload.email}`)
          user = await User.query({ client: trx }).where('email', payload.email).first()

          if (user) {
            // Utilisateur trouvé par email -> Lier le compte Google
            logger.info(`User ${user.id} trouvé par email, liaison google_id ${payload.sub}`)
            user.google_id = payload.sub
            // Met à jour la photo si l'utilisateur n'en a pas et Google en fournit une
            if (user.photo.length === 0 && payload.picture) {
              user.photo = [payload.picture]
              logger.info(`Mise à jour photo pour user ${user.id} depuis Google`)
            }
            await user.useTransaction(trx).save() // Sauvegarde dans la transaction
          } else {
            // 4. Ni Google ID, ni Email -> Nouvel utilisateur (Client par défaut)
            isNewUser = true
            logger.info(`Création nouvel user (Client) via Google pour ${payload.email}`)
            const randomPassword = string.generateRandom(32) // Génère un mdp aléatoire fort

            user = await User.create(
              {
                email: payload.email,
                password: randomPassword, // Requis, mais non utilisé pour la connexion Google
                full_name: payload.name || `Utilisateur ${payload.given_name || 'Google'}`, // Utilise name ou given_name
                google_id: payload.sub,
                // role: role === RoleType.CLIENT ? RoleType.CLIENT : RoleType.DRIVER,
                photo: payload.picture ? [payload.picture] : [],
              },
              { client: trx }
            )
            logger.info(`Nouvel user ${user.id} créé (dans TRX)`)
            user.useTransaction(trx)
            // Crée le client associé pour ce nouvel utilisateur
            if (role === RoleType.CLIENT) {
              await Client.create(
                {
                  user_id: user.id,
                  // id: cuid(), // Si clé primaire séparée
                  api_key: `secret_${string.generateRandom(32)}`,
                  is_valid_client: true,
                  order_count: 0,
                  // subscription_id: ID_SOUSCRIPTION_PAR_DEFAUT, // A adapter
                },
                { client: trx }
              )
              logger.info(`Client associé créé pour nouvel user ${user.id} (dans TRX)`)
            }
            if (role === RoleType.DRIVER) {
              await Driver.create(
                {
                  user_id: user.id, // Utilise le même ID
                  // id: cuid(), // si PK séparée
                  average_rating: 0,
                  is_valid_driver: false, // Doit être validé
                  delivery_stats: { success: 0, failure: 0, total: 0 },
                },
                { client: trx }
              )
              logger.info(`Driver associé créé pour nouvel user ${user.id} (dans TRX)`)
            }
          }
        } else {
          logger.info(`User ${user.id} trouvé directement via google_id: ${payload.sub}`)
        }

        // 5. Vérifications de validité (optionnel, cf login)
        // ...

        // 6. Crée le token manuellement DANS LA TRANSACTION
        // const rawToken = string.generateRandom(60) // token brut
        // const tokenHash = await hash.make(rawToken)
        // const token = await user.related('tokens').create({
        //   name: 'auth_via_google',
        //   abilities: JSON.stringify(['*']),
        //   type: 'bearer',
        //   hash: tokenHash,
        //   expiresAt: DateTime.now().plus({ days: 30 }),
        // })

        logger.info(`Création du token pour user ${user.id} (dans TRX)`)
        // 7. Commit la transaction
        await trx.commit()
        logger.info(`Transaction commitée pour google sign-in user ${user.id}`)
        
        const token = await User.accessTokens.create(user, ['*'], {
          name: 'auth_via_google',
          expiresIn: 30 * 24 * 60 * 60, // 30 jours
        })
        // --- Fin Transaction ---

        // 8. Charge la relation pertinente post-commit
        if (role === RoleType.CLIENT) await user.load('client')
        if (role === RoleType.DRIVER) await user.load('driver') // Au cas où un driver se co via Google

        const responseData = {
          user: user.serialize({ fields: { omit: ['password', 'remember_me_token'] } }),
          token: token.value?.release(), // Utilise le token brut généré
        }

        if (isNewUser) {
          return response.created(responseData)
        } else {
          return response.ok(responseData)
        }
      } catch (dbError) {
        // Gère les erreurs DANS la transaction (ex: violation contrainte DB)
        logger.error({ err: dbError, userId: user?.id }, 'Erreur DB pendant transaction google sign-in')
        if (!trx.isCompleted) {
          await trx.rollback()
          logger.warn(`Transaction rollbackée (erreur DB) pour google sign-in user ${user?.id || payload.email}`)
        }
        throw dbError // Relance pour le catch externe
      }
    } catch (error) {
      // Gère les erreurs hors transaction (vérification token Google, erreurs relancées)
      //@ts-ignore
      logger.error({ err: error, google_payload: payload, userId: user?.id }, 'Erreur globale lors de handle_google_sign_in')
      return response.badRequest({
        message: 'Erreur lors de la connexion Google',
        error: process.env.NODE_ENV === 'development' ? error.message : "Une erreur inattendue est survenue.",
      })
    }
  }

  /**
   * Permet à un utilisateur connecté (généralement un Client)
   * de démarrer le processus pour devenir Driver.
   * POST /driver/start_onboarding (nécessite middleware auth)
   */
  async start_driver_onboarding({ auth, response }: HttpContext) {
    await auth.authenticate() // Assure l'authentification et charge l'utilisateur
    const user = await auth.authenticate()
    logger.info(`Début onboarding driver pour user ${user.id} (${user.email})`)

    // Charge explicitement client et driver pour vérification
    await user.load('client')
    await user.load('driver')

    // Vérifier si déjà Driver
    if (user?.driver?.is_valid_driver) {
      logger.warn(`User ${user.id} est déjà Driver, tentative onboarding refusée.`)
      return response.badRequest({ message: 'Vous êtes déjà enregistré comme livreur.' })
    }
    // Vérifier si un enregistrement driver existe déjà (cas possible ?)
    if (user.driver.id && !user.driver.is_valid_driver) {
      logger.warn(`User ${user.id} a déjà un enregistrement Driver, tentative onboarding refusée.`)
      return response.badRequest({ message: 'Un processus de livreur est déjà associé à votre compte. Veuillez patientez' })
    }

    const trx = await db.transaction()
    try {
      // // 1. Changer le rôle de l'utilisateur
      // await user.useTransaction(trx).save()
      // logger.info(`Rôle User ${user.id} changé en DRIVER (dans TRX)`)

      // 2. Créer l'enregistrement Driver associé
      await Driver.create(
        {
          user_id: user.id, // Utilise le même ID
          // id: cuid(), // si PK séparée
          average_rating: 0,
          is_valid_driver: false, // Doit être validé
          delivery_stats: { success: 0, failure: 0, total: 0 },
        },
        { client: trx }
      )
      logger.info(`Enregistrement Driver créé pour user ${user.id} (dans TRX)`)

      // 3. Optionnel: Supprimer/désactiver l'enregistrement Client ?
      // if (user.client) {
      //    logger.info(`Désactivation/Suppression enregistrement Client ${user.client.id} pour user ${user.id}`);
      //    user.client.is_valid_client = false; // Désactiver
      //    await user.client.useTransaction(trx).save();
      //    // OU: await user.client.useTransaction(trx).delete(); // Supprimer
      // }

      await trx.commit()
      logger.info(`Transaction onboarding driver commitée pour user ${user.id}`)

      // Recharger l'utilisateur avec sa nouvelle relation driver
      await user.refresh() // Recharge l'instance user
      await user.load('driver')

      return response.ok({
        message:
          'Processus pour devenir livreur initié. Veuillez maintenant soumettre vos documents via les écrans appropriés.',
        user: user.serialize({ fields: { omit: ['password'] } }),
      })
    } catch (error) {
      logger.error({ err: error, userId: user.id }, "Erreur lors du démarrage de l'onboarding livreur")
      if (!trx.isCompleted) {
        await trx.rollback()
        logger.warn(`Transaction onboarding driver rollbackée pour user ${user.id}`)
      }
      return response.internalServerError({ message: 'Une erreur est survenue lors du démarrage du processus.' })
    }
  }

  /**
   * Déconnecte l'utilisateur en révoquant le token actuel.
   * POST /logout (nécessite middleware auth)
   */
  async logout({ auth, response }: HttpContext) {
    await auth.authenticate() // Authentifie et charge l'utilisateur + token courant
    const user = await auth.authenticate()

    // L'identifiant du token est disponible via auth.user?.currentAccessToken
    const tokenIdentifier = auth.user?.currentAccessToken?.identifier

    if (!tokenIdentifier) {
      logger.error(`Impossible de trouver l'identifier du token actuel pour logout user ${user.id}`)
      // Ne devrait pas se produire si authentifié
      return response.badRequest({ message: 'Impossible de déterminer le token actuel.' })
    }

    try {
      logger.info(`Tentative de révocation token id ${tokenIdentifier} pour user ${user.id}`)
      // Révoque le token spécifique utilisé via sa PK (identifier)
      await User.accessTokens.delete(user, tokenIdentifier)
      logger.info(`Token id ${tokenIdentifier} révoqué avec succès pour user ${user.id}`)
      return response.ok({ message: 'Déconnexion réussie.' })
    } catch (error) {
      logger.error(
        { err: error, userId: user.id, tokenId: tokenIdentifier },
        'Erreur lors de la révocation du token de déconnexion'
      )
      return response.internalServerError({ message: 'Erreur lors de la déconnexion.' })
    }
  }

  /**
   * Récupère le profil de l'utilisateur authentifié.
   * GET /profile (nécessite middleware auth)
   */
  // async profile({ auth, response }: HttpContext) {
  //   await auth.authenticate()
  //   const user = await auth.authenticate()
  //   logger.debug(`Récupération profil pour user ${user.id}`)

  //   // Charge les relations pertinentes de manière sélective
  //   const relationsToLoad: ('client' | 'driver')[] = []
  //   if (user.role === RoleType.CLIENT) {
  //     relationsToLoad.push('client')
  //   } else if (user.role === RoleType.DRIVER) {
  //     relationsToLoad.push('driver')
  //   }

  //   // Exemple de chargement conditionnel plus complexe
  //   await user.load((loader) => {
  //     if (user.role === RoleType.CLIENT) {
  //       loader.load('client', clientQuery => {
  //         // clientQuery.preload('subscription') // Charger relation imbriquée si besoin
  //       })
  //     } else if (user.role === RoleType.DRIVER) {
  //       loader.load('driver', driverQuery => {
  //         // driverQuery.preload('vehicles').preload('user_document') // Charger relations du driver
  //       })
  //       // Charger aussi les documents directement sur l'utilisateur si nécessaire
  //       // loader.load('documents')
  //     }
  //   })
  //   logger.info(`Profil renvoyé pour user ${user.id}`)
  //   return response.ok(user.serialize({
  //     fields: { omit: ['password', 'remember_me_token'] } // Toujours omettre les champs sensibles
  //   }))
  // }
}