import router from '@adonisjs/core/services/router'
import { middleware } from './kernel.js'

// ... autres imports et routes ...
const DriverStatusController = () => import('#controllers/driver_status_controller')
const OrderTrackingController = () => import('#controllers/SSE/order_trackings_controller')
const ProfileController = () => import('#controllers/profiles_controller')
const DriverAvailabilityController = () => import('#controllers/driver_availability_controller')
const AuthController = () => import('#controllers/auth_controller')
const UserDocumentController = () => import('#controllers/driver_documents_controller')

// Auth routes
router.post('/register_user', [AuthController, 'register_user'])
router.post('/register_driver', [AuthController, 'register_driver'])
router.post('/login', [AuthController, 'login'])
router.post('/auth/google/callback', [AuthController, 'handle_google_sign_in'])
router.post('/logout', [AuthController, 'logout']).use(middleware.auth({ guards: ['api'] }))
router.get('/profile', [AuthController, 'profile']).use(middleware.auth({ guards: ['api'] }))

// Onboarding Route
router.post('/driver/start_onboarding', [AuthController, 'start_driver_onboarding'])

router
  .group(() => {
    router.get('/documents', [UserDocumentController, 'show']) // Récupérer les documents soumis
    router.post('/documents', [UserDocumentController, 'store_or_update']) // Soumettre/Mettre à jour
  })
  .prefix('/driver') // Préfixe pour les routes spécifiques au livreur
  .use(middleware.auth({ guards: ['api'] })) // Doit être connecté
// .use(middleware.acl({ roles: ['driver'] })) // Doit avoir le rôle driver

router
  .group(() => {
    router.get('/profile', [ProfileController, 'me']) // Lire le profil
    router.patch('/profile', [ProfileController, 'update']) // Mettre à jour (PATCH pour màj partielle)
    // ou: router.put('/profile', [ProfileController, 'update']) // PUT si on remplace toute la ressource
  })
  .use(middleware.auth({ guards: ['api'] })) // Nécessite authentification pour les deux

router
  .group(() => {
    // ... autres routes /driver (vehicles, documents, etc) ...

    // --- Gestion de la Disponibilité du Driver ---
    router.get('/availability/rules', [DriverAvailabilityController, 'list_rules'])
    router.post('/availability/rules', [DriverAvailabilityController, 'add_rule'])
    router.patch('/availability/rules/:ruleId', [DriverAvailabilityController, 'update_rule'])
    router.delete('/availability/rules/:ruleId', [DriverAvailabilityController, 'delete_rule'])

    router.get('/availability/exceptions', [DriverAvailabilityController, 'list_exceptions'])
    router.post('/availability/exceptions', [DriverAvailabilityController, 'add_exception'])
    router.patch('/availability/exceptions/:exceptionId', [
      DriverAvailabilityController,
      'update_exception',
    ])
    router.delete('/availability/exceptions/:exceptionId', [
      DriverAvailabilityController,
      'delete_exception',
    ])
  })
  .prefix('/driver')
  .use(middleware.auth({ guards: ['api'] }))

// --- Route SSE Publique pour le Suivi ---
// Utilise un préfixe distinct ou place-la en dehors des groupes authentifiés
router.get('/track-stream/:id', [OrderTrackingController, 'stream'])

router
  .group(() => {
    // ... autres routes /driver (vehicles, documents, availability ...) ...

    // --- Gestion Statut & Localisation du Driver ---
    router.patch('/status', [DriverStatusController, 'update_status']) // Le driver change son statut manuel
    router.post('/location', [DriverStatusController, 'update_location']) // Le driver envoie sa position GPS
    router.get('/status', [DriverStatusController, 'get_current_status']) // Récupère le dernier statut enregistré
  })
  .prefix('/driver')
  .use(middleware.auth({ guards: ['api'] }))
// .use(middleware.acl({ roles: ['driver'] }))
