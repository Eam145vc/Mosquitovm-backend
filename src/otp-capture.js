// Captura efímera de OTP / códigos de confirmación que el banco manda al alias
// cuando el cliente cambia su correo de notificaciones.
//
// SEGURIDAD: el OTP expira a los ~10 min y se borra cuando el cliente confirma.
// Se persiste CIFRADO (AES-256-GCM, misma llave que los refresh tokens) para
// sobrevivir reinicios de pm2 — antes vivía solo en RAM y cada deploy lo borraba
// justo cuando el cliente lo esperaba (incidente Ricardo jul-2026). Nunca queda
// en la DB más de 10 minutos.

import { saveOtpCode, loadOtpCode, deleteOtpCode, purgeOtpCodes, getOrderByAccount, lastWaInboundAt } from './storage.js';
import { logger } from './logger.js';
import { normalizePhoneCO, firstNameOf } from './wa-enqueue.js';
import { sendCloudTemplate, sendCloudText, isTemplateApproved, sanitizeParam } from './wa-cloud.js';

const TTL_MS = 10 * 60 * 1000;          // 10 minutos

// Plantilla AUTHENTICATION (código directo en el WA). BLOQUEADA por Meta hasta que
// apruebe la verificación del negocio (status "pending", jul-2026): ni la API ni el
// BM dejan crearla (error 2388185). Cuando la verificación pase, se crea a mano en
// el BM (Autenticación → copiar código, idioma es) y esta ruta arranca sola.
const WA_OTP_TEMPLATE = 'sono_otp_banco';
// Plantilla UTILITY de respaldo: NO lleva el código (Meta rechaza códigos en
// Utilidad), solo avisa que llegó + botón a la pantalla donde se ve.
// Ninguna va en WA_TEMPLATES: formas distintas y el script de creación no debe tocarlas.
const WA_AVISO_TEMPLATE = 'sono_otp_aviso';

// Anti-spam: 1 aviso por código y máx 3 por hora por cuenta (los bancos reenvían
// el mismo correo y el cliente puede pedir varios códigos seguidos).
const waOtpSent = new Map(); // accountId → { codes: Set, ats: number[] }

// El código del banco expira en ~10 min y la cola wa_outbox tiene horarios y
// delays humanizados que lo matarían: por eso va DIRECTO por la Cloud API.
// Fire-and-forget: su fallo jamás bloquea la captura (la pantalla sigue siendo
// la vía principal; esto es el refuerzo que le llega al celular).
async function notifyOtpWa(accountId, code) {
  try {
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

    // Tres rutas, de mejor a peor experiencia:
    let via;
    if (isTemplateApproved(WA_OTP_TEMPLATE)) {
      // 1) Plantilla de autenticación: el código llega directo, con botón copiar.
      await sendCloudTemplate(phone, {
        name: WA_OTP_TEMPLATE,
        language: { code: 'es' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      });
      via = 'auth-template';
    } else if ((lastWaInboundAt(phone) || 0) > now - 24 * 3600_000) {
      // 2) Ventana de servicio abierta (nos escribió hace <24h): texto libre CON el código.
      await sendCloudText(
        phone,
        `⚡ Llegó el código de tu banco: *${code}*\n\nEscríbelo en la pantalla de tu banco para terminar de conectar tu Sonó. Vence en 10 minutos.`
      );
      via = 'texto-24h';
    } else if (isTemplateApproved(WA_AVISO_TEMPLATE)) {
      // 3) Aviso sin código + botón a la pantalla de conexión (ahí se ve el código).
      await sendCloudTemplate(phone, {
        name: WA_AVISO_TEMPLATE,
        language: { code: 'es' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: sanitizeParam(firstNameOf(order), 'cliente') }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: order.id }] },
        ],
      });
      via = 'aviso-template';
    } else {
      logger.warn({ accountId }, 'otp-wa: sin ruta disponible (ventana cerrada y plantillas sin aprobar)');
      return;
    }
    e.codes.add(code);
    e.ats.push(now);
    waOtpSent.set(accountId, e);
    logger.info({ accountId, via }, 'otp-wa: aviso del código enviado por WhatsApp');
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
