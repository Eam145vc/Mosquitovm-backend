// Filtra los speakers que están ONLINE de verdad, pingueándolos.
//
// Los speakers NO publican status solos: solo responden a getinfo (por eso en el
// admin se ven "offline" hasta que alguien los despierta). Para saber quién está
// online AHORA: se manda getinfo a todos los candidatos, se espera la respuesta
// (entra por speakers/<id>/status y actualiza last_seen en devices) y se filtra
// por last_seen posterior al ping, con un margen chico por la escritura async.

import { publishCommand } from './mqtt-publisher.js';
import { listDevices } from './storage.js';

export const PING_WAIT_MS = 3_000;   // cuánto esperar las respuestas al getinfo
export const PING_GRACE_MS = 10_000; // un status que entró justito antes del ping también cuenta

/** De `spkrIds`, devuelve solo los que respondieron el ping (online ahora).
 *  `deps` es inyectable solo para los tests. */
export async function filterOnline(spkrIds, deps = {}) {
  const {
    publish = publishCommand,
    devices = listDevices,
    waitMs = PING_WAIT_MS,
    graceMs = PING_GRACE_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = deps;
  if (!spkrIds.length) return [];
  const pingAt = now();
  // qos 0: si el speaker está offline, el getinfo no debe quedar encolado en el broker.
  await Promise.allSettled(spkrIds.map((s) => publish(s, { cmd: 'getinfo' }, { qos: 0 })));
  await sleep(waitMs);
  const seen = new Map(devices().map((d) => [d.spkr_id, d.last_seen ?? 0]));
  return spkrIds.filter((s) => (seen.get(s) ?? 0) >= pingAt - graceMs);
}
