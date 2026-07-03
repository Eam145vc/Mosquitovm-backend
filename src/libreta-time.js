// Cortes de día para "La Libreta". Aislado en su propio módulo para testearlo
// sin abrir DB ni levantar Fastify.

export const BOGOTA_OFFSET_MS = 5 * 3600 * 1000; // America/Bogota = UTC-5 FIJO, sin DST
export const DAY_MS = 24 * 3600 * 1000;
/** Epoch ms de la medianoche Bogotá que contiene `now`. NUNCA usar el día local del VM. */
export function bogotaDayStart(now = Date.now()) {
  return Math.floor((now - BOGOTA_OFFSET_MS) / DAY_MS) * DAY_MS + BOGOTA_OFFSET_MS;
}
