// Captura efímera de OTP / códigos de confirmación que el banco manda al alias
// cuando el cliente cambia su correo de notificaciones.
//
// SEGURIDAD: el OTP expira a los ~10 min y se borra cuando el cliente confirma.
// Se persiste CIFRADO (AES-256-GCM, misma llave que los refresh tokens) para
// sobrevivir reinicios de pm2 — antes vivía solo en RAM y cada deploy lo borraba
// justo cuando el cliente lo esperaba (incidente Ricardo jul-2026). Nunca queda
// en la DB más de 10 minutos.

import { saveOtpCode, loadOtpCode, deleteOtpCode, purgeOtpCodes, getOrderByAccount } from './storage.js';
import { logger } from './logger.js';
import { normalizePhoneCO } from './wa-enqueue.js';
import { sendCloudTemplate, isTemplateApproved } from './wa-cloud.js';

const TTL_MS = 10 * 60 * 1000;          // 10 minutos

// Plantilla AUTHENTICATION creada a mano en el Business Manager (la API del token
// no puede crear esa categoría). NO va en WA_TEMPLATES: forma distinta (botón
// copiar código, texto fijo de Meta) y el script de creación no debe tocarla.
const WA_OTP_TEMPLATE = 'sono_otp_banco';

// Anti-spam: 1 aviso por código y máx 3 por hora por cuenta (los bancos reenvían
// el mismo correo y el cliente puede pedir varios códigos seguidos).
const waOtpSent = new Map(); // accountId → { codes: Set, ats: number[] }

// El código del banco expira en ~10 min y la cola wa_outbox tiene horarios y
// delays humanizados que lo matarían: por eso va DIRECTO por la Cloud API.
// Fire-and-forget: su fallo jamás bloquea la captura (la pantalla sigue siendo
// la vía principal; esto es el refuerzo que le llega al celular).
async function notifyOtpWa(accountId, code) {
  try {
    if (!isTemplateApproved(WA_OTP_TEMPLATE)) {
      logger.warn({ accountId }, 'otp-wa: plantilla sono_otp_banco no aprobada aún — no se envía');
      return;
    }
    const now = Date.now();
    const e = waOtpSent.get(accountId) || { codes: new Set(), ats: [] };
    e.ats = e.ats.filter((t) => now - t < 3600_000);
    if (e.codes.has(code) || e.ats.length >= 3) return;
    const order = getOrderByAccount(accountId);
    const phone = normalizePhoneCO(order?.phone);
    if (!phone) {
      logger.warn({ accountId }, 'otp-wa: la cuenta no tiene orden con teléfono');
      return;
    }
    await sendCloudTemplate(phone, {
      name: WA_OTP_TEMPLATE,
      language: { code: 'es' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    });
    e.codes.add(code);
    e.ats.push(now);
    waOtpSent.set(accountId, e);
    logger.info({ accountId }, 'otp-wa: código del banco enviado por WhatsApp');
  } catch (err) {
    logger.warn({ accountId, err: err.message }, 'otp-wa: falló el envío (no bloquea la captura)');
  }
}

// Patrones de "esto es un correo con un código de verificación" (banco confirmando
// el cambio de correo). En español colombiano.
const OTP_CONTEXT = /(c[oó]digo|verificaci[oó]n|confirma|confirmaci[oó]n|token|clave\s+temporal|c[oó]digo\s+de\s+seguridad|OTP)/i;

// Extrae el código numérico del texto. Bancos suelen usar 4 a 8 dígitos.
function extractCode(text) {
  if (!text) return null;
  // Preferir un número cerca de la palabra "código/verificación".
  const near = text.match(/(?:c[oó]digo|verificaci[oó]n|confirma\w*|token|OTP)[^0-9]{0,40}(\d{4,8})/i);
  if (near) return near[1];
  // Si no, el primer bloque aislado de 4-8 dígitos (no parte de un monto con $).
  const m = text.match(/(?<![$\d.,])\b(\d{4,8})\b(?![\d.,])/);
  return m ? m[1] : null;
}

/**
 * Analiza un correo entrante. Si parece un código de confirmación (y NO un pago),
 * guarda el OTP efímero para ese accountId. Devuelve true si capturó un OTP.
 */
export function maybeCaptureOtp(accountId, { subject = '', text = '', html = '' }) {
  const body = `${subject}\n${text || stripTags(html)}`;
  if (!OTP_CONTEXT.test(body)) return false;
  const code = extractCode(body);
  if (!code) return false;
  saveOtpCode(accountId, code);
  purgeOtpCodes(TTL_MS); // barrer vencidos de paso (baratísimo, tabla diminuta)
  notifyOtpWa(accountId, code); // sin await: el WA es refuerzo, no requisito
  return true;
}

/** Lee el OTP de una cuenta, si hay uno vigente. */
export function readOtp(accountId) {
  const e = loadOtpCode(accountId);
  if (!e) return null;
  if (Date.now() - e.at >= TTL_MS) {
    deleteOtpCode(accountId);
    return null;
  }
  return { code: e.code, at: e.at };
}

/** Limpia el OTP tras usarlo (el cliente confirmó). */
export function clearOtp(accountId) {
  deleteOtpCode(accountId);
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
}
