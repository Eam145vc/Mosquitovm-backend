// Config de PM2 para sono-backend.
// Clave: max_memory_restart reinicia el proceso solo si la RAM se descontrola
// (red de seguridad contra cuelgues por loop/leak mientras Sonó comparte VM con
// fanlink). El backend usa ~200MB normal; 600MB = algo se fue de control → reinicio
// preventivo antes de que el OOM del host lo cuelgue.
//
// Arranque: pm2 start ecosystem.config.cjs
// El .env se carga vía start.sh (set -a; source .env), igual que el arranque manual.

module.exports = {
  apps: [
    {
      name: 'sono-backend',
      script: './start.sh',
      cwd: '/home/deploy/sono/backend',
      interpreter: 'bash',
      max_memory_restart: '600M',
      // Si crashea en bucle, esperar más entre reinicios (evita martilleo).
      exp_backoff_restart_delay: 2000,
      // No reiniciar más de 15 veces en una ventana corta (si pasa, algo está roto).
      max_restarts: 15,
      min_uptime: '20s',
      autorestart: true,
      // Logs (PM2 ya los maneja, dejamos defaults).
      time: true,
    },
  ],
};
