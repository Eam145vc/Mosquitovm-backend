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
  const receivedAt = Date.now();           // [C]
  const bankDate = extractBankDate(body);  // [A]
  const feReceived = extractLastReceived(body); // [B]
  return {
    receivedAt,
    bankDate,
    feReceived,
    // tramos (ms); null si falta el timestamp de origen
    bankToBackendMs: bankDate ? receivedAt - bankDate : null,    // A→C
    feToBackendMs: feReceived ? receivedAt - feReceived : null,  // B→C
    backendToVoiceMs: null,                                       // C→D (se completa luego)
  };
}

/** Marca el instante en que se publicó el voice por MQTT y registra todo. */
export function markVoicePublished(lat, ctx = {}) {
  if (!lat) return;
  lat.backendToVoiceMs = Date.now() - lat.receivedAt; // C→D
  const line = {
    ...ctx,
    bankToBackendMs: lat.bankToBackendMs,
    feToBackendMs: lat.feToBackendMs,
    backendToVoiceMs: lat.backendToVoiceMs,
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
