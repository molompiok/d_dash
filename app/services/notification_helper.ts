// app/services/notification_helper.ts
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import admin from 'firebase-admin'
import User from '#models/user' // Pour la fonction de nettoyage
import fs from 'node:fs'

let isFirebaseInitialized = false

export type SendNotificationResult =
  | { success: true; messageId: string } // Succès : renvoie l'ID du message FCM
  | { success: false; error: any; code?: string; isTokenInvalid?: boolean } // Échec : détails de l'erreur

// Initialise Firebase (doit être appelée au démarrage de l'app/worker)
async function initializeFirebaseApp() {
  if (isFirebaseInitialized) return
  const serviceAccountPath = env.get('FIREBASE_SERVICE_ACCOUNT_KEY_PATH')
  if (!serviceAccountPath) {
    logger.error('FIREBASE_SERVICE_ACCOUNT_KEY_PATH non défini.')
    return
  }
  try {
    const serviceAccountRaw = await fs.promises.readFile(serviceAccountPath, 'utf-8')
    const serviceAccount = JSON.parse(serviceAccountRaw)
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
    isFirebaseInitialized = true
    logger.info('Firebase Admin SDK initialisé.')
  } catch (error) {
    logger.error(
      { err: error, path: serviceAccountPath },
      'Erreur initialisation Firebase Admin SDK'
    )
  }
}

class NotificationHelper {
  /**
   * Envoie une notification Push via FCM et retourne un résultat détaillé.
   */
  public async sendPushNotification(
    fcmToken: string,
    title: string,
    body: string,
    data?: { [key: string]: any } // Accepte n'importe quel objet
  ): Promise<SendNotificationResult> {
    if (!isFirebaseInitialized) {
      logger.warn('Attempted to send notification but Firebase SDK is not initialized.')
      return {
        success: false,
        error: new Error('Firebase not initialized'),
        code: 'FIREBASE_NOT_INIT',
      }
    }
    if (!fcmToken) {
      logger.warn({ title }, 'Attempted to send notification with no FCM token.')
      return { success: false, error: new Error('No FCM Token provided'), code: 'NO_FCM_TOKEN' }
    }
    if (!fcmToken || !title || !body) {
      logger.warn({ fcmToken, title, body }, 'Invalid notification parameters.')
      return {
        success: false,
        error: new Error('Missing required parameters'),
        code: 'INVALID_PARAMETERS',
        isTokenInvalid: !fcmToken,
      }
    }

    // Définit la structure du message avec les options Android/iOS
    const message: admin.messaging.Message = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'critical_alerts', // Canal pour notifications critiques
          sound: 'default', // Son par défaut
          visibility: 'public', // Visible sur écran verrouillé
          vibrateTimingsMillis: [1000],
          priority: 'high',
          clickAction: 'OPEN_APP',
          notificationCount: 1,
          // TODO: Définir un Channel ID si nécessaire pour Android 8+
          // channelId: env.get('ANDROID_NOTIFICATION_CHANNEL_ID', 'default_channel')
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1, // Réinitialiser le badge ou incrémenter? À gérer côté app mobile.
          },
        },
        // Option pour forcer l'affichage en arrière-plan sur iOS 10+
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
      },
      token: fcmToken,
      data: data ? this.stringifyDataPayload(data) : {}, // Assure que toutes les data sont string
    }

    try {
      logger.debug(
        { fcmTokenStart: fcmToken.substring(0, 10), title },
        `Attempting to send FCM message...`
      )
      // Envoi réel du message
      const response = await admin.messaging().send(message)
      logger.info(
        `FCM message sent successfully. Message ID: ${response}. Token: ${fcmToken.substring(0, 10)}...`
      )
      // Succès : retourne un objet avec success=true et l'ID du message FCM
      return { success: true, messageId: response }
    } catch (error: any) {
      // Capture l'erreur FCM
      logger.error(
        { err: error, fcmToken: fcmToken.substring(0, 10), title },
        'FCM send message failed'
      )

      let isTokenInvalid = false
      const errorCode = error.code // Extrait le code d'erreur standard FCM

      // --- Logique de Détection de Token Invalide ---
      if (
        errorCode === 'messaging/registration-token-not-registered' ||
        errorCode === 'messaging/invalid-registration-token'
      ) {
        logger.warn(
          `Invalid/Unregistered FCM token detected: ${fcmToken.substring(0, 10)}... Code: ${errorCode}`
        )
        isTokenInvalid = true
        // Lancer la suppression en arrière plan (sans await)
        this.removeInvalidToken(fcmToken).catch((err) =>
          logger.error({ err, fcmToken }, 'Error removing invalid token in background')
        )
      }

      if (errorCode === 'messaging/quota-exceeded') {
        logger.warn('FCM quota exceeded, should retry later.')
        return { success: false, error, code: errorCode, isTokenInvalid: false }
      }
      // ---------------------------------------------

      // Échec : retourne un objet avec success=false, l'erreur originale, le code FCM et l'indicateur isTokenInvalid
      return {
        success: false,
        error: error, // L'objet erreur complet pour inspection potentielle
        code: errorCode || 'UNKNOWN_FCM_ERROR', // Le code d'erreur FCM ou une valeur par défaut
        isTokenInvalid: isTokenInvalid, // Le flag calculé
      }
    }
  } // Fin sendPushNotification

  /**
   * Convertit toutes les valeurs d'un payload de données en string,
   * car FCM Data Payload les requiert.
   */
  private stringifyDataPayload(data: { [key: string]: any }): { [key: string]: string } {
    const stringifiedData: { [key: string]: string } = {}
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const value = data[key]
        // Si la valeur est déjà une chaîne, la garde telle quelle.
        // Si c'est un nombre, booléen ou null/undefined, le convertit.
        // Si c'est un objet/tableau, le JSON.stringify.
        if (typeof value === 'string') {
          stringifiedData[key] = value
        } else if (
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null ||
          value === undefined
        ) {
          stringifiedData[key] = String(value)
        } else {
          try {
            stringifiedData[key] = JSON.stringify(value)
          } catch (e) {
            logger.warn(
              { key, value },
              `Could not stringify value for FCM data payload, skipping key.`
            )
          }
        }
      }
    }
    return stringifiedData
  }

  /**
   * Supprime un token FCM invalide de la base de données (appelée en arrière-plan).
   */
  async removeInvalidToken(fcmToken: string): Promise<void> {
    if (!fcmToken) return
    logger.info(
      `Attempting to remove invalid FCM token ending with ${fcmToken.slice(-10)} from User and Driver tables.`
    )
    try {
      // Utilisation de Promise.all pour lancer les updates en parallèle
      const [userUpdateResult] = await Promise.all([
        User.query().where('fcm_token', fcmToken).update({ fcm_token: null }),
      ])

      const totalAffected = userUpdateResult[0] || 0

      if (totalAffected > 0) {
        logger.info(
          `Removed invalid FCM token ending with ${fcmToken.slice(-10)} from ${totalAffected} record(s).`
        )
      } else {
        logger.warn(
          `Attempted to remove token ending with ${fcmToken.slice(-10)}, but no records were found with it.`
        )
      }
    } catch (error) {
      logger.error(
        { err: error, tokenEnd: fcmToken.slice(-10) },
        `Failed to remove invalid FCM token from DB.`
      )
      // Aucune action supplémentaire nécessaire ici, l'erreur est loguée.
    }
  }
} // Fin classe NotificationHelper

// Exporte une instance pour utilisation facile
const notificationHelperInstance = new NotificationHelper()
export default notificationHelperInstance
export { notificationHelperInstance as NotificationHelper, initializeFirebaseApp } // Double export pour compatibilité
