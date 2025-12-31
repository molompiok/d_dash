// app/services/ws_service.ts
import { Server } from 'socket.io'
// Pas besoin d'Ignitor ici, on va utiliser directement le type de serveur de Node.js
import type { Server as HttpServer } from 'node:http'

class WsService {
  public io!: Server
  private booted = false

  // CORRECTION : On type explicitement l'argument comme un serveur HTTP de Node.js
  public boot(server: HttpServer) {
    if (this.booted) {
      return
    }

    this.booted = true
    this.io = new Server(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    })

    this.io.on('connection', (socket) => {
      console.log('✅ Company connecté au socket:', socket.id)

      socket.on('authenticate', (data) => {
        if (data && data.driverId) {
          console.log(`🔒 Authentification du livreur ${data.driverId} sur le socket ${socket.id}`)
          socket.join(`driver_${data.driverId}`)
          socket.emit('authenticated', { message: 'Authentification réussie' })
        } else {
          socket.emit('authentication_error', { message: 'driverId manquant' })
        }
      })

      socket.on('disconnect', (reason) => {
        console.log(`❌ Company déconnecté du socket ${socket.id}: ${reason}`)
      })
    })
  }
}

export default new WsService()