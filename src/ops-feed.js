// Bus de eventos en vivo para la sección Operación del admin (HUD).
//
// En memoria, sin dependencias: cada módulo emite lo que va pasando (pago
// anunciado, speaker que reporta telemetría, broker que se cae/vuelve) y los
// clientes SSE conectados en /admin/ops/stream lo reciben al instante. Un ring
// buffer corto permite "ponerse al día" al conectar o reconectar (Last-Event-ID).

const listeners = new Set();
const recent = [];
const MAX_RECENT = 80;
let seq = 0;

/** Emite un evento a todos los suscriptores y lo guarda en el ring buffer.
 *  type: 'payment' | 'status' | 'broker'. data se aplana en el evento. */
export function opsEmit(type, data = {}) {
  const ev = { id: ++seq, at: Date.now(), type, ...data };
  recent.push(ev);
  if (recent.length > MAX_RECENT) recent.shift();
  for (const fn of listeners) {
    try { fn(ev); } catch { /* un suscriptor roto no tumba a los demás */ }
  }
  return ev;
}

/** Suscribe un callback(ev). Devuelve la función para desuscribirse. */
export function opsSubscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Eventos recientes con id > sinceId (para replay al conectar el SSE). */
export function opsRecent(sinceId = 0) {
  return recent.filter((e) => e.id > sinceId);
}
