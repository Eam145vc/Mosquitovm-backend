// Captura efímera de OTP / códigos de confirmación que el banco manda al alias
// cuando el cliente cambia su correo de notificaciones.
//
// SEGURIDAD: el OTP expira a los ~10 min y se borra cuando el cliente confirma.
// Se persiste CIFRADO (AES-256-GCM, misma llave que los refresh tokens) para
// sobrevivir reinicios de pm2 — antes vivía solo en RAM y cada deploy lo borraba
// justo cuando el cliente lo esperaba (incidente Ricardo jul-2026). Nunca queda
// en la DB más de 10 minutos.

import { saveOtpCode, loadOtpCode, deleteOtpCode, purgeOtpCodes } from './storage.js';

const TTL_MS = 10 * 60 * 1000;          // 10 minutos

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
