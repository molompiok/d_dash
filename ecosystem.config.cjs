const path = require('path'); // Importez le module path

const TOTAL_AVAILABILITY_WORKERS = 1; // Exemple: Lancer 4 instances

// Déterminez le chemin correct vers votre point d'entrée Ace
// Vérifiez si 'ace.js' existe à la racine ou si c'est 'bin/ace.js'
const aceScript = path.resolve(__dirname, 'ace.js'); // Adaptez si c'est 'bin/ace.js'

module.exports = {
  apps: [
    {
      name: 'assignment-worker',
      script: aceScript,          // Pointe vers le fichier ace.js ou bin/ace.js
      args: 'assignment:worker', // La commande Ace est l'argument
      interpreter: 'node',       // Assure que node est utilisé
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      out_file: './logs/assignment-worker-out.log',
      error_file: './logs/assignment-worker-error.log',
      env_production: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'notification-worker',
      script: aceScript,          // Pointe vers le fichier ace.js ou bin/ace.js
      args: 'notification:worker', // La commande Ace est l'argument
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      out_file: './logs/notification-worker-out.log',
      error_file: './logs/notification-worker-error.log',
      env_production: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'availability-sync-worker',
      script: aceScript,               // Pointe vers le fichier ace.js ou bin/ace.js
      args: 'availability:sync-status', // La commande Ace est l'argument
      interpreter: 'node',
      exec_mode: 'fork',
      instances: TOTAL_AVAILABILITY_WORKERS,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      out_file: './logs/availability-sync-worker-out.log',
      error_file: './logs/availability-sync-worker-error.log',
      env_production: {
        NODE_ENV: 'production',
        TOTAL_WORKERS: `${TOTAL_AVAILABILITY_WORKERS}`,
      },
    },
    {
      name: 'billing-worker',
      script: aceScript,          // Pointe vers le fichier ace.js ou bin/ace.js
      args: 'billing:worker',    // La commande Ace pour le BillingWorker
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,              // Une instance pour commencer, ajustez si nécessaire
      autorestart: true,
      watch: false,
      max_memory_restart: '512M', // Similaire aux autres workers
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      out_file: './logs/billing-worker-out.log',
      error_file: './logs/billing-worker-error.log',
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};