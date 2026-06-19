// Cache simple de Message-IDs procesados con TTL para evitar anunciar el mismo
// pago dos veces si IMAP reenvia un mail (pasa en reconexiones).

const STORE = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;  // 24 horas

export function isDuplicate(messageId) {
  if (!messageId) return false;
  cleanup();
  if (STORE.has(messageId)) return true;
  STORE.set(messageId, Date.now());
  return false;
}

function cleanup() {
  const now = Date.now();
  for (const [k, t] of STORE) {
    if (now - t > TTL_MS) STORE.delete(k);
  }
}

export function size() { return STORE.size; }
