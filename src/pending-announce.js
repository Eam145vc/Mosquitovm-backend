// Último pago pendiente por speaker, para anunciarlo UNA sola vez cuando el
// speaker vuelva online.
//
// Antes los voice iban con qos 1: el firmware usa sesión persistente, así que
// el broker ENCOLABA cada pago mientras el speaker estaba apagado y al encender
// los recitaba TODOS uno por uno (spam). Ahora los voice van qos 0 (no se
// encolan) y acá se guarda solo el ÚLTIMO pago por speaker: cada pago nuevo
// pisa al anterior. Se entrega cuando el speaker responde un getinfo (entra por
// speakers/<id>/status → handler en index.js). El ping periódico de index.js +
// los getinfo que el broker le suelta al reconectar hacen de despertador.
//
// En memoria: un reinicio del backend pierde el pendiente (aceptado: es 1
// anuncio de cortesía, el pago ya quedó persistido en la DB y en La Libreta).

const pending = new Map(); // spkrId → { playAudibleMsg, amount, at }

export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000; // >24h ya no se anuncia

export function setPending(spkrId, { playAudibleMsg, amount }, now = Date.now) {
  pending.set(spkrId, { playAudibleMsg, amount, at: now() });
}

/** Un pago nuevo (que ya sonó en vivo) invalida cualquier pendiente anterior. */
export function clearPending(spkrId) { pending.delete(spkrId); }

/** Saca y devuelve el pendiente vigente (o null si no hay o venció). Borra
 *  SIEMPRE antes de devolver: dos status seguidos no lo entregan dos veces. */
export function takePending(spkrId, now = Date.now) {
  const p = pending.get(spkrId);
  if (!p) return null;
  pending.delete(spkrId);
  if (now() - p.at > PENDING_MAX_AGE_MS) return null;
  return p;
}
