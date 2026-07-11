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
 * Formatos conocidos (hora Colombia GMT-5, sin DST):
 *  - Nequi Bre-B:  "Fecha:</th><td>11/07/2026 12:56:52</td>"  → CON segundos
 *  - Bancolombia:  "...el 26/06/2026 a las 16:34. Con codigo QR..." → SIN segundos (±60s)
 * Devuelve { ms, hasSeconds } (epoch ms UTC), o null si no matchea ningún patrón.
 */
function extractBodyPaidAt(text) {
  if (!text || typeof text !== 'string') return null;
  // 1) "DD/MM/YYYY HH:MM:SS" (Nequi). Con segundos: hora del pago exacta por sí sola.
  let m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\b/);
  if (m) {
    const [, dd, mm, yyyy, hh, min, ss] = m.map(Number);
    const utcMs = Date.UTC(yyyy, mm - 1, dd, hh + 5, min, ss);
    if (Number.isFinite(utcMs)) return { ms: utcMs, hasSeconds: true };
  }
  // 2) "el DD/MM/YYYY a las HH:MM" (Bancolombia, 24h). Tolera espacios variables.
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s+a\s+las\s+(\d{1,2}):(\d{2})\b/i);
  if (m) {
    const [, dd, mm, yyyy, hh, min] = m.map(Number);
    // Date.UTC con +5h evita que el TZ del server interfiera.
    const utcMs = Date.UTC(yyyy, mm - 1, dd, hh + 5, min, 0);
    if (Number.isFinite(utcMs)) return { ms: utcMs, hasSeconds: false };
  }
  return null;
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
  const bodyPaid = extractBodyPaidAt(bodyText);        // { ms, hasSeconds } | null
  const paidAt = bodyPaid ? bodyPaid.ms : null;
  const headerDate = body?.date ? parseDate(body.date) : extractBankDate(body); // CON segundos
  // [B] cuándo el MX (mx.sono.lat) recibió el correo del banco.
  const mxReceived = Number(body?.receivedAtMs) || null;

  // BASE para medir la demora:
  //  - Cuerpo CON segundos (Nequi) → es la hora exacta del pago: se usa directo, precisa.
  //  - Cuerpo SIN segundos (Bancolombia): si el header cae en el MISMO minuto del cuerpo,
  //    o en los PRIMEROS segundos del minuto siguiente (pago 16:34:58 → correo 16:35:01,
  //    cruce de minuto legítimo), el banco emitió al instante → header fiable y CON
  //    segundos → precisión exacta. La tolerancia corta (10s) evita disfrazar de rápida
  //    una cola real de ~1 min (header 16:35:45 con cuerpo 16:34 NO pasa).
  //  - Si difieren más → hubo cola antes del Date → el header miente → cuerpo (±60s).
  //  - Sin cuerpo → header (degradado, comportamiento viejo).
  const ADJ_TOLERANCE_S = 10;
  let bankDate;
  let precise;
  if (paidAt != null && bodyPaid.hasSeconds) {
    bankDate = paidAt; precise = true;
  } else if (paidAt != null && headerDate != null) {
    const minPaid = Math.floor(paidAt / 60_000);
    const minHdr = Math.floor(headerDate / 60_000);
    const secHdr = Math.floor((headerDate % 60_000) / 1000);
    const headerOk = minHdr === minPaid || (minHdr === minPaid + 1 && secHdr < ADJ_TOLERANCE_S);
    bankDate = headerOk ? headerDate : paidAt;
    precise = headerOk;
  } else {
    bankDate = paidAt != null ? paidAt : headerDate;
    precise = false;
  }
  const usedHeaderForPrecision = precise;
  return {
    receivedAt,
    bankDate,
    paidAt,        // hora del cuerpo (pago real, minutos), null si no se pudo extraer
    headerDate,    // header Date del banco (con segundos)
    mxReceived,
    precise: usedHeaderForPrecision,  // true = medido con segundos (header≈cuerpo); false = ±60s
    // Demora del pago hasta el MX. Base = header (segundos) si coincide en minuto con el
    // cuerpo; si no, cuerpo (minutos). Captura cola antes del Date Y viaje lento después.
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
  // La ÚNICA demora confiable es CUERPO → MX (bankToBackendMs): captura tanto la cola
  // de SendClean ANTES del Date (header fresco engañoso) como un viaje lento DESPUÉS
  // del Date (header=cuerpo pero llega tarde). Comparar header−cuerpo NO sirve: da
  // falso "al instante" cuando la demora está después del Date. Resolución ±60s
  // (el cuerpo no trae segundos). paidAt/headerDate quedan SOLO como diagnóstico.
  const line = {
    ...ctx,
    bankToBackendMs: lat.bankToBackendMs,   // demora del pago hasta el MX (la única confiable)
    feToBackendMs: lat.feToBackendMs,
    backendToVoiceMs: lat.backendToVoiceMs,
    precise: lat.precise ?? false,          // true = medido con segundos; false = ±60s (resolución minuto)
    paidAt: lat.paidAt ?? null,             // diagnóstico: hora del pago (cuerpo)
    headerDate: lat.headerDate ?? null,     // diagnóstico: header Date (con segundos)
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
