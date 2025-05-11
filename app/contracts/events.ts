// contracts/events.ts
import { NotificationType } from '#models/notification'
import { OrderStatus } from '#models/order'
import OrderStatusLog from '#models/order_status_log'

// Données pour une mise à jour de statut
export type OrderStatusUpdatePayload = {
  order_id: string
  client_id: string // L'ID de l'utilisateur client à notifier
  new_status: OrderStatus
  timestamp: string // ISO Timestamp
  // Inclure potentiellement le log entier pour plus de détails?
  log_entry?: OrderStatusLog // Optionnel
}

// Données pour une mise à jour de localisation
export type DriverLocationUpdatePayload = {
  order_id: string // Pour savoir à quelle commande ce driver est lié
  client_id: string // ID client
  driver_id: string
  location: { latitude: number; longitude: number }
  timestamp: string // ISO Timestamp de la localisation
  // Inclure ETA calculé ici ?
  eta_seconds?: number | null
}

// export type NotificationType = 'NEW_MISSION_OFFER' | 'MISSION_ASSIGNED' | 'PAYMENT_RECEIVED' | 'MISSION_CANCELLED_ADMIN' | 'SUPPORT_MESSAGE' | 'SCHEDULE_REMINDER' | 'MISSION_UPDATE'

export interface CustomNotificationData {
  type: NotificationType | string; // Allow string for potential future types not yet in enum
  order_id?: string;
  offer_details?: string; // JSON string
  mission_id?: string;
  message?: string;
  title?: string; // Often comes from data payload
  body?: string;  // Often comes from data payload
  // Add specific fields as needed
  [key: string]: any;
}

// Données pour une notification push
export type NotificationPayload = {
  fcmToken: string;
  title: string;
  // order_id?: string;
  // offer_details?: string;
  // vehicle_id?: string;
  // mission_id?: string;
  // document_id?: string;
  body: string;
  data: { [key: string]: any; type: NotificationType };
}

// Déclare les événements dans l'interface EventsList
declare module '@adonisjs/core/types' {
  interface EventsList {
    // Nom de l'événement : type du payload
    'order:status_updated': OrderStatusUpdatePayload
    'order:driver_location_updated': DriverLocationUpdatePayload
  }
}
