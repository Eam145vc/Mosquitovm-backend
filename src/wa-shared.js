// Helpers compartidos por los enviadores de WhatsApp (wa-sender Evolution y
// wa-cloud oficial). Módulo neutro y sin dependencias para que borrar un
// enviador muerto nunca rompa al otro.

// Colombia es UTC-5 fijo (sin DST): la hora local sale con offset plano, sin Intl.
const BOGOTA_OFFSET_MS = 5 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export function bogotaHour(now = Date.now()) {
  return Math.floor(((now - BOGOTA_OFFSET_MS) % DAY_MS) / (3600 * 1000));
}

export function startOfBogotaDay(now = Date.now()) {
  return Math.floor((now - BOGOTA_OFFSET_MS) / DAY_MS) * DAY_MS + BOGOTA_OFFSET_MS;
}

export function withinActiveHours(hour, start, end) {
  return hour >= start && hour < end; // fin exclusivo, igual que el agente PC
}

export function randDelay(min, max, rnd = Math.random) {
  return Math.floor(min + (max - min) * rnd());
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
