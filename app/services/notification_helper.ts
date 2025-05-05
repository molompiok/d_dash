// app/services/notification_helper.ts
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import admin from 'firebase-admin'
import User from '#models/user' // Pour la fonction de nettoyage

let isFirebaseInitialized = false

export type SendNotificationResult =
  | { success: true; messageId: string } // Succès : renvoie l'ID du message FCM
  | { success: false; error: any; code?: string; isTokenInvalid?: boolean } // Échec : détails de l'erreur

// Initialise Firebase (doit être appelée au démarrage de l'app/worker)
interface ServiceAccount {
  type: string | undefined;
  project_id: string | undefined;
  private_key_id: string | undefined;
  private_key: string | undefined;
  client_email: string | undefined;
  client_id: string | undefined;
  auth_uri: string | undefined;
  token_uri: string | undefined;
  auth_provider_x509_cert_url: string | undefined;
  client_x509_cert_url: string | undefined;
  universe_domain: string | undefined;
}

async function initializeFirebaseApp() {
  if (isFirebaseInitialized) return;

  try {
    const serviceAccount: ServiceAccount = {
      type: env.get('FIREBASE_TYPE'),
      project_id: env.get('FIREBASE_PROJECT_ID'),
      private_key_id: env.get('FIREBASE_PRIVATE_KEY_ID'),
      private_key: env.get('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
      client_email: env.get('FIREBASE_CLIENT_EMAIL'),
      client_id: env.get('FIREBASE_CLIENT_ID'),
      auth_uri: env.get('FIREBASE_AUTH_URI'),
      token_uri: env.get('FIREBASE_TOKEN_URI'),
      auth_provider_x509_cert_url: env.get('FIREBASE_AUTH_PROVIDER_X509_CERT_URL'),
      client_x509_cert_url: env.get('FIREBASE_CLIENT_X509_CERT_URL'),
      universe_domain: env.get('FIREBASE_UNIVERSE_DOMAIN'),
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
    });

    isFirebaseInitialized = true;
    logger.info('Firebase Admin SDK initialisé.');
  } catch (error) {
    logger.error(
      { err: error },
      'Erreur initialisation Firebase Admin SDK'
    );
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
    data?: { [key: string]: any }, // Accepte n'importe quel objet
    options: { priority?: 'high' | 'normal'; type?: string } = {}
  ): Promise<SendNotificationResult> {
    if (!isFirebaseInitialized) {
      initializeFirebaseApp();
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

    const effectiveType = options.type || data?.type || 'default'; // Utilise type des options, puis data, puis défaut
    const isHighPriority = options.priority === 'high' || effectiveType === 'NEW_MISSION_OFFER'; // Exemple

    // Récupère les IDs/sons depuis l'environnement avec fallback
    const androidChannelId = isHighPriority
      ? env.get('ANDROID_HIGH_PRIORITY_CHANNEL_ID', 'high_priority_channel')
      // : Env.get('ANDROID_CRITICAL_ALERTS_CHANNEL_ID', 'critical_alerts'); // Ou un autre canal par défaut
      : env.get('ANDROID_DEFAULT_CHANNEL_ID', 'default_channel'); // Utilisons le canal par défaut pour les non-urgents

    const soundAndroid = isHighPriority
      ? env.get('FCM_OFFER_SOUND_ANDROID', 'custom_offer_sound')
      : env.get('FCM_DEFAULT_SOUND_ANDROID', 'default');

    const soundIOS = isHighPriority
      ? env.get('FCM_OFFER_SOUND_IOS', 'custom_offer_sound.wav')
      : env.get('FCM_DEFAULT_SOUND_IOS', 'default');

    const androidPriority1 = isHighPriority ? 'high' : 'normal';
    const androidPriority2 = isHighPriority ? 'high' : 'default';
    const apnsPriority = isHighPriority ? '10' : '5';

    // Définit la structure du message avec les options Android/iOS
    const message: admin.messaging.Message = {
      notification: { title, body },
      android: {
        priority: androidPriority1,
        notification: {
          channelId: androidChannelId, // Canal pour notifications critiques
          sound: soundAndroid, // Son par défaut
          visibility: 'public', // Visible sur écran verrouillé
          vibrateTimingsMillis: [1000],
          priority: androidPriority2,
          // clickAction: 'OPEN_APP',
          notificationCount: 1,
          // TODO: Définir un Channel ID si nécessaire pour Android 8+
          // channelId: env.get('ANDROID_NOTIFICATION_CHANNEL_ID', 'default_channel')
        },
      },
      apns: {
        payload: {
          aps: {
            sound: soundIOS,
            badge: 1, // Réinitialiser le badge ou incrémenter? À gérer côté app mobile.
          },
        },
        // Option pour forcer l'affichage en arrière-plan sur iOS 10+
        headers: { 'apns-priority': apnsPriority, 'apns-push-type': 'alert' },
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
