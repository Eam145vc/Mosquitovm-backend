// Medición de latencia del pipeline de pago por correo.
//
// El flujo es: pago real → banco EMITE correo → ForwardEmail lo recibe → reenvía
// a nuestro webhook → parser → MQTT → speaker reproduce.
//
// No podemos medir el instante exacto del pago (el banco no lo expone), pero SÍ
// podemos descomponer la latencia en tramos usando los timestamps que ya viajan
// en el correo:
//
//   [A] Date:      cuándo el banco dice que emitió el correo
//   [B] Received:  último salto antes de nosotros (ForwardEmail) — su timestamp
//   [C] now()      cuándo llegó a nuestro webhook
//   [D] now()      cuándo publicamos el voice por MQTT
//
//   A→C = banco emite + viaje + ForwardEmail  (caja negra del banco; lo más grande)
//   B→C = ForwardEmail → nosotros             (responsabilidad de ForwardEmail)
//   C→D = nuestro parser + MQTT               (responsabilidad nuestra)
//
// Así, cuando un cliente dice "se demoró", sabemos en qué tramo se fue el tiempo
// y si es problema del banco (irresoluble) o nuestro (accionable).

import { logger } from './logger.js';
import { recordLatency } from './latency-store.js';

/** Parsea una fecha de header de correo a epoch ms, o null si no se puede. */
function parseDate(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Extrae la HORA REAL DEL PAGO del CUERPO del correo del banco (no del header Date,
 * que el banco rellena de forma inconsistente: a veces atrasado, a veces "fresco"
 * aunque el correo salió tarde). El cuerpo siempre trae la hora del pago real.
 *
 * Bancolombia: "...el 26/06/2026 a las 16:34. Con codigo QR es facil..."
 * Resolución: MINUTOS (sin segundos) → precisión ±60s. Asume hora Colombia (GMT-5).
 * Devuelve epoch ms UTC, o null si no se encuentra el patrón.
 */
function extractBodyPaidAt(text) {
  if (!text || typeof text !== 'string') return null;
  // "el DD/MM/YYYY a las HH:MM" (24h). Tolera espacios variables.
  const m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s+a\s+las\s+(\d{1,2}):(\d{2})\b/i);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m.map(Number);
  // El cuerpo está en hora local Colombia (GMT-5, sin DST). Construimos el epoch UTC
  // sumando 5h al wall-clock colombiano. Date.UTC evita que el TZ del server interfiera.
  const utcMs = Date.UTC(yyyy, mm - 1, dd, hh + 5, min, 0);
  return Number.isFinite(utcMs) ? utcMs : null;
}

/**
 * Extrae el timestamp del header `Date:` del correo.
 * body puede traer: body.date (mailparser ya lo da como Date/string) o estar en headers.
 */
function extractBankDate(body) {
  if (!body) return null;
  // mailparser: body.date suele venir como ISO string o Date
  if (body.date) {
    const t = body.date instanceof Date ? body.date.getTime() : parseDate(body.date);
    if (t) return t;
  }
  // headers como objeto o como string crudo
  const h = body.headers;
  if (h) {
    if (typeof h.get === 'function') { const t = parseDate(h.get('date')); if (t) return t; }
    if (typeof h === 'object' && (h.date || h.Date)) { const t = parseDate(h.date || h.Date); if (t) return t; }
    if (typeof h === 'string') {
      const m = h.match(/^date:\s*(.+)$/im);
      if (m) { const t = parseDate(m[1]); if (t) return t; }
    }
  }
  return null;
}

/**
 * Extrae el timestamp del PRIMER header `Received:` (el salto más reciente = ForwardEmail).
 * Los Received se apilan: el de arriba (primero) es el último salto antes de nosotros.
 * Formato típico: "Received: from ... ; Wed, 18 Jun 2026 14:43:09 -0500"
 */
function extractLastReceived(body) {
  if (!body) return null;
  let raw = '';
  const h = body.headers;
  if (typeof h === 'string') raw = h;
  else if (body.headerLines && Array.isArray(body.headerLines)) {
    raw = body.headerLines.map((l) => l.line || '').join('\n');
  } else if (typeof body.raw === 'string') {
    raw = body.raw.slice(0, 8000); // headers viven al inicio del MIME
  }
  if (!raw) return null;
  // Primer "Received:" — su fecha va después del último ';'
  const m = raw.match(/^received:[\s\S]*?;\s*(.+)$/im);
  if (m) return parseDate(m[1].split(/\r?\n/)[0].trim());
  return null;
}

/**
 * Calcula los tramos de latencia en el momento en que llega el correo al webhook.
 * Llamar al INICIO del handler (apenas se parsea el body) para fijar receivedAt.
 *
 * Devuelve un objeto que luego se completa con markVoicePublished().
 */
export function startLatency(body) {
  const receivedAt = Date.now();           // [C] llegada al backend
  // [A] HORA REAL DEL PAGO: la del CUERPO del correo ("a las HH:MM"). Es la única
  //     hora confiable: el header Date el banco lo rellena inconsistente (a veces
  //     atrasado, a veces "fresco" aunque el correo salió tarde). Precisión ±60s.
  const bodyText = body?.text || body?.html || '';
  const paidAt = extractBodyPaidAt(bodyText);
  // Header Date del banco — se conserva solo como referencia/diagnóstico, ya NO es la
  // base de bankToBackendMs (mentía según el día). Fallback si el cuerpo no trae hora.
  const headerDate = body?.date ? parseDate(body.date) : extractBankDate(body);
  // bankDate = la base del cálculo: cuerpo si existe, si no el header (degradado).
  const bankDate = paidAt || headerDate;
  // [B] cuándo el MX (mx.sono.lat) recibió el correo del banco.
  const mxReceived = Number(body?.receivedAtMs) || null;
  return {
    receivedAt,
    bankDate,
    paidAt,        // hora del cuerpo (pago real), null si no se pudo extraer
    headerDate,    // header Date del banco (referencia, ya no es la base)
    mxReceived,
    // Banco→Sonó: de la HORA DEL PAGO (cuerpo) hasta que el MX lo recibió. Ahora
    // refleja la latencia real punta-a-punta (incluye la demora del banco en emitir).
    // Si no hay hora de cuerpo, cae al header (comportamiento viejo, degradado).
    bankToBackendMs: bankDate ? (mxReceived || receivedAt) - bankDate : null,
    // MX→backend: del recibo en el MX hasta el webhook (nuestra red interna).
    feToBackendMs: mxReceived ? receivedAt - mxReceived : null,
    backendToVoiceMs: null,                                       // C→D (se completa luego)
  };
}

/** Marca el instante en que se publicó el voice por MQTT y registra todo. */
export function markVoicePublished(lat, ctx = {}) {
  if (!lat) return;
  lat.backendToVoiceMs = Date.now() - lat.receivedAt; // C→D
  // Demora del banco en EMITIR el correo = header Date − hora del pago (cuerpo).
  // El cuerpo no trae segundos, así que esto tiene resolución de MINUTOS: si header y
  // cuerpo caen en el mismo minuto → 0 (sin demora, "al instante"). Si difieren, el
  // valor en minutos es la demora real del banco. null si falta alguno de los dos.
  const bankEmitDelayMs = (lat.paidAt != null && lat.headerDate != null)
    ? Math.max(0, lat.headerDate - lat.paidAt)
    : null;
  // Viaje del correo ya emitido = del header Date hasta que el MX lo recibió (red, preciso).
  const emailTravelMs = (lat.headerDate != null && lat.mxReceived != null)
    ? Math.max(0, lat.mxReceived - lat.headerDate)
    : null;
  const line = {
    ...ctx,
    bankToBackendMs: lat.bankToBackendMs,
    feToBackendMs: lat.feToBackendMs,
    backendToVoiceMs: lat.backendToVoiceMs,
    bankEmitDelayMs,   // demora del banco en emitir (header−cuerpo), resolución minutos
    emailTravelMs,     // viaje del correo emitido (header→MX), preciso
    paidAt: lat.paidAt ?? null,
    headerDate: lat.headerDate ?? null,
  };
  // Alerta si algún tramo se dispara (umbrales conservadores).
  const slowBank = lat.bankToBackendMs != null && lat.bankToBackendMs > 60_000;
  const slowFe = lat.feToBackendMs != null && lat.feToBackendMs > 15_000;
  const slowUs = lat.backendToVoiceMs != null && lat.backendToVoiceMs > 5_000;
  if (slowBank || slowFe || slowUs) {
    logger.warn({ ...line, slowBank, slowFe, slowUs }, 'latencia alta en pipeline de pago');
  } else {
    logger.info(line, 'latencia pipeline de pago');
  }
  recordLatency(line); // acumula para el panel admin
  return line;
}
