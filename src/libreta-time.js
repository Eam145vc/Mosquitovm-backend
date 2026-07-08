// Cortes de día para "La Libreta". Aislado en su propio módulo para testearlo
// sin abrir DB ni levantar Fastify.

export const BOGOTA_OFFSET_MS = 5 * 3600 * 1000; // America/Bogota = UTC-5 FIJO, sin DST
export const DAY_MS = 24 * 3600 * 1000;
/** Epoch ms de la medianoche Bogotá que contiene `now`. NUNCA usar el día local del VM. */
export function bogotaDayStart(now = Date.now()) {
  return Math.floor((now - BOGOTA_OFFSET_MS) / DAY_MS) * DAY_MS + BOGOTA_OFFSET_MS;
}

/** Epoch ms de la medianoche Bogotá del día 1 del mes que contiene `now`. */
export function bogotaMonthStart(now = Date.now()) {
  const d = new Date(now - BOGOTA_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + BOGOTA_OFFSET_MS;
}

/** Epoch ms de la medianoche Bogotá del día 1 del mes ANTERIOR al de `now`. */
export function bogotaPrevMonthStart(now = Date.now()) {
  const d = new Date(now - BOGOTA_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) + BOGOTA_OFFSET_MS;
}

/** "YYYY-MM-DD" (día calendario Bogotá) → epoch ms de su medianoche Bogotá.
 *  null si el string no es una fecha real (2026-02-31, 2026-13-01, basura). */
export function bogotaDayStartFromKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const dt = new Date(utc);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return utc + BOGOTA_OFFSET_MS;
}
