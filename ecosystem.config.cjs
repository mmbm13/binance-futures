/**
 * PM2 — un proceso por estrategia. Ejecutar desde la raíz del repo:
 *   npm run build
 *   pm2 start ecosystem.config.cjs
 *
 * Las variables en `env` tienen prioridad sobre .env / .env.<strategy>.
 * El resto de config (DB, API keys, parámetros) se lee de .env + .env.<strategy>.
 */
const path = require('path');

const root = __dirname;

const paperApps = [
  // { name: 'bot-momentum', strategy: 'momentum', port: 3002 },
  // { name: 'bot-bounce', strategy: 'bounce', port: 3003 },
  // { name: 'bot-liqrev', strategy: 'liqrev', port: 3004 },
  // { name: 'bot-funding', strategy: 'funding', port: 3005 },
];

const liveApps = [{ name: 'bot-ladder', strategy: 'ladder', port: 3001, executionMode: 'live' }];

function app({ name, strategy, port, executionMode = 'paper' }) {
  return {
    name,
    script: path.join(root, 'dist/api/server.js'),
    cwd: root,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '600M',
    merge_logs: false,
    error_file: path.join(root, 'logs/pm2', `${name}-error.log`),
    out_file: path.join(root, 'logs/pm2', `${name}-out.log`),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      NODE_ENV: 'production',
      STRATEGY: strategy,
      EXECUTION_MODE: executionMode,
      PORT: port,
    },
  };
}

module.exports = {
  apps: [...liveApps, ...paperApps].map(app),
};
