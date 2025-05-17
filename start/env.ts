/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),

  /*
  |----------------------------------------------------------
  | Variables for configuring database connection
  |----------------------------------------------------------
  */
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),
  FILE_STORAGE_PATH: Env.schema.string(),
  FILE_STORAGE_URL: Env.schema.string(),

  /*
  |----------------------------------------------------------
  | Variables for configuring ally package
  |----------------------------------------------------------
  */
  GOOGLE_CLIENT_ID: Env.schema.string(),
  GOOGLE_CLIENT_SECRET: Env.schema.string(),

  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  REDIS_PASSWORD: Env.schema.string.optional(),

  DRIVER_OFFER_DURATION_SECONDS: Env.schema.number(),
  DRIVER_SEARCH_RADIUS_KM: Env.schema.number(),
  ASSIGNMENT_EXPIRATION_SCAN_INTERVAL_MS: Env.schema.number(),
  MAX_ASSIGNMENT_ATTEMPTS: Env.schema.number(),
  MAX_EVENTS_PER_POLL: Env.schema.number(),
  ASSIGNMENT_STREAM_KEY: Env.schema.string(),
  WORKER_POLLING_INTERVAL_MS: Env.schema.number(),
  OFFER_EXPIRATION_SCAN_INTERVAL_MS: Env.schema.number(),

  /*
  |----------------------------------------------------------
  | Variables for configuring notification worker
  |----------------------------------------------------------
  */
  NOTIFICATION_WORKER_POLL_INTERVAL: Env.schema.number(),
  NOTIFICATION_WORKER_MAX_EVENTS: Env.schema.number(),
  NOTIFICATION_WORKER_BLOCK_MS: Env.schema.number(),
  NOTIFICATION_WORKER_CLAIM_IDLE_MS: Env.schema.number(),
  NOTIFICATION_WORKER_MAX_RETRY: Env.schema.number(),
  NOTIFICATION_WORKER_DEAD_CONSUMER_IDLE_MS: Env.schema.number(),
  NOTIFICATION_WORKER_CLAIM_CHECK_FREQUENCY: Env.schema.number(),


  /*
  |----------------------------------------------------------
  | Variables for configuring availability sync worker
  |----------------------------------------------------------
  */
  AVAILABILITY_SYNC_BATCH_SIZE: Env.schema.number(),
  AVAILABILITY_SYNC_TOTAL_WORKERS: Env.schema.number(),
  AVAILABILITY_SYNC_WORKER_ID: Env.schema.number(),
  AVAILABILITY_CACHE_TTL_SECONDS: Env.schema.number(),
  AVAILABILITY_SYNC_INTERVAL_MS: Env.schema.number(),

  /*
  |----------------------------------------------------------
  | Variables for configuring billing worker
  |----------------------------------------------------------
  */
  BILLING_WORKER_POLL_INTERVAL: Env.schema.number(),
  BILLING_WORKER_MAX_EVENTS: Env.schema.number(),
  BILLING_WORKER_BLOCK_MS: Env.schema.number(),
  BILLING_WORKER_CLAIM_IDLE_MS: Env.schema.number(),
  BILLING_WORKER_MAX_RETRY: Env.schema.number(),
  BILLING_WORKER_DEAD_CONSUMER_IDLE_MS: Env.schema.number(),
})
