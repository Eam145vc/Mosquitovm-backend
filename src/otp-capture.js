// Captura efímera de OTP / códigos de confirmación que el banco manda al alias
// cuando el cliente cambia su correo de notificaciones.
//
// SEGURIDAD (regla "no persisto nada"): el OTP vive SOLO en memoria, expira a los
// ~10 min, y se borra apenas el frontend lo lee. NUNCA toca disco ni la DB.

const TTL_MS = 10 * 60 * 1000;          // 10 minutos
const store = new Map();                // accountId -> { code, raw, at }

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
  store.set(accountId, { code, at: Date.now() });
  // auto-limpieza por TTL
  setTimeout(() => {
    const e = store.get(accountId);
    if (e && Date.now() - e.at >= TTL_MS) store.delete(accountId);
  }, TTL_MS + 1000).unref?.();
  return true;
}

/** Lee (y consume) el OTP de una cuenta, si hay uno vigente. Una sola lectura. */
export function readOtp(accountId) {
  const e = store.get(accountId);
  if (!e) return null;
  if (Date.now() - e.at >= TTL_MS) {
    store.delete(accountId);
    return null;
  }
  return { code: e.code, at: e.at };
}

/** Limpia el OTP tras usarlo (el cliente confirmó). */
export function clearOtp(accountId) {
  store.delete(accountId);
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
}
