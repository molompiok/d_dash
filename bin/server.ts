// bin/server.ts

import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { createServer } from 'node:http' // Importer createServer
import Ws from '#services/ws_service'   // Importer votre service

const APP_ROOT = new URL('../', import.meta.url)

const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.booting(async () => {
      await import('#start/env')
    })
    app.listen('SIGTERM', () => app.terminate())
    app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
  })
  .httpServer()
  // Appliquez cette modification :
  .start((handler) => {
    // Créez le serveur HTTP en utilisant le gestionnaire de requêtes d'AdonisJS
    const server = createServer(handler)

    // Initialisez votre service WebSocket avec l'instance du serveur
    Ws.boot(server)
    console.log(`info: Booted WebSocket server`)

    // Retournez le serveur pour qu'AdonisJS puisse l'utiliser
    // AdonisJS gérera automatiquement l'écoute sur le port configuré dans .env (PORT=3333)
    return server
  })
  .catch((error) => {
    process.exitCode = 1
    prettyPrintError(error)
  })