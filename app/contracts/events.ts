// contracts/events.ts
import { OrderStatus } from '#models/order'
import OrderStatusLog from '#models/order_status_log'

// Données pour une mise à jour de statut
export type OrderStatusUpdatePayload = {
  orderId: string
  clientId: string // L'ID de l'utilisateur client à notifier
  newStatus: OrderStatus
  timestamp: string // ISO Timestamp
  // Inclure potentiellement le log entier pour plus de détails?
  logEntry?: OrderStatusLog // Optionnel
}

// Données pour une mise à jour de localisation
export type DriverLocationUpdatePayload = {
  orderId: string // Pour savoir à quelle commande ce driver est lié
  clientId: string // ID client
  driverId: string
  location: { latitude: number; longitude: number }
  timestamp: string // ISO Timestamp de la localisation
  // Inclure ETA calculé ici ?
  etaSeconds?: number | null
}

// Déclare les événements dans l'interface EventsList
declare module '@adonisjs/core/types' {
  interface EventsList {
    // Nom de l'événement : type du payload
    'order:status_updated': OrderStatusUpdatePayload
    'order:driver_location_updated': DriverLocationUpdatePayload
  }
}
