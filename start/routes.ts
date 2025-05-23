import router from '@adonisjs/core/services/router'
import { middleware } from './kernel.js'
import OrderController from '#controllers/orders_controller'
import DriverVehicleController from '#controllers/driver_vehicles_controller'
import MissionController from '#controllers/missions_controller'

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
router.post('/auth_google', [AuthController, 'handle_google_sign_in'])

router
  .group(() => {
    router.patch('/profile', [ProfileController, 'update'])
    router.post('/logout', [AuthController, 'logout'])
    router.get('/profile', [ProfileController, 'me'])
  })
// .use(middleware.auth({ guards: ['api'] }))

// Onboarding Route
router.post('/driver/start_onboarding', [AuthController, 'start_driver_onboarding'])

router
  .group(() => {
    // Routes véhicules
    router.get('/vehicles', [DriverVehicleController, 'index'])
    router.get('/vehicles/:id', [DriverVehicleController, 'show'])
    router.post('/vehicles', [DriverVehicleController, 'create_vehicle'])
    router.patch('/vehicles/:id', [DriverVehicleController, 'update_vehicle'])
    router.delete('/vehicles/:id', [DriverVehicleController, 'delete_vehicle'])
    // Routes documents véhicules
    router.get('/documents', [UserDocumentController, 'show'])
    router.post('/documents', [UserDocumentController, 'store_or_update'])
  })
  .prefix('/driver')
  .use(middleware.auth({ guards: ['api'] }))


router.group(() => {
  router.patch('/documents/:id/status', [UserDocumentController, 'admin_update_status'])
  router.patch('/vehicles/:id/status', [DriverVehicleController, 'admin_update_status'])
})
  .use(middleware.auth({ guards: ['api'] }))

router
  .group(() => {
    router.get('/availability/rules', [DriverAvailabilityController, 'list_rules'])
    router.post('/availability/rules', [DriverAvailabilityController, 'add_rule'])
    router.patch('/availability/rules', [DriverAvailabilityController, 'update_rules_batch'])
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

// Public SSE route for tracking
router.get('/track-stream/:id', [OrderTrackingController, 'stream'])

router.get('/missions/current', [MissionController, 'show'])

router
  .group(() => {
    router.patch('/status', [DriverStatusController, 'update_status'])
    router.post('/location', [DriverStatusController, 'update_location'])
    router.get('/status', [DriverStatusController, 'get_current_status'])
  })
  .prefix('/driver')
  .use(middleware.auth({ guards: ['api'] }))


router.group(() => {
  router.post('/orders/:id/assign', [OrderController, 'admin_assign_driver'])
})
  .prefix('/admin')
  .use(middleware.auth({ guards: ['api'] }))

router.get('/uploads/*', ({ request, response }) => {
  return response.download('.' + request.url())
})


router
  .group(() => {
    router.post('/orders', [OrderController, 'create_order'])
    router.get('orders/:order_id/legs/:legSequence/reroute', [OrderController, 'reroute_order_leg'])
    router.get('orders/:order_id/offer-details', [OrderController, 'get_offer_details'])
    router.patch('/orders/:order_id/waypoints/:waypoint_sequence/status', [MissionController, 'update_waypoint_status'])
  })
  .use(middleware.auth({ guards: ['api'] }))

