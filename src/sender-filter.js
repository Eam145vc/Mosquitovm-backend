// Filtro de remitentes: solo aceptamos correos que vengan de un banco conocido Y que
// pasen autenticación (SPF/DKIM). Esto evita que alguien que adivine un alias inyecte
// pagos falsos: tendría que falsificar el remitente del banco, y un correo spoofeado
// falla SPF/DKIM (que ForwardEmail valida y nos pasa en el payload).
//
// NOTA: el sufijo aleatorio del alias se MANTIENE (resuelve colisión de nombres). Este
// filtro es una capa de seguridad ADICIONAL, no un reemplazo del sufijo.

// Dominios de remitente válidos (bancos soportados: SOLO Bancolombia, Nequi, BBVA).
// Daviplata y Davivienda se retiraron (jul-2026); su dominio davivienda.com queda FUERA.
const BANK_DOMAINS = [
  'bancolombia.com',
  'notificacionesbancolombia.com',
  'nequi.com.co',
  'bbva.com',
];

/** ¿El remitente es de un banco conocido? */
export function isKnownBankSender(from) {
  const f = String(from || '').toLowerCase();
  return BANK_DOMAINS.some((d) => f.includes(d));
}

/**
 * ¿El correo está autenticado? ForwardEmail manda los resultados de SPF/DKIM/DMARC en el
 * payload. Aceptamos si DKIM pasa O SPF pasa (un correo spoofeado falla ambos).
 * Si el payload no trae esa info (formato distinto), no bloqueamos (fail-open controlado:
 * el filtro de dominio + el sufijo del alias ya dan seguridad).
 */
export function passesAuth(payload = {}) {
  // Lee el resultado en los DISTINTOS formatos del proveedor:
  //  - "pass"/"fail" (string)
  //  - { status: "pass" } | { status: { result: "pass" } } | { result: "pass" } | { valid: true }
  //  - DKIM de ForwardEmail: { results: [ { status: { result: "pass" } }, ... ] }
  const ok = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') return /pass/i.test(v);
    if (typeof v === 'object') {
      if (Array.isArray(v.results)) {                       // DKIM multi-firma: pasa si ALGUNA pasa
        return v.results.length ? v.results.some((r) => ok(r) === true) : null;
      }
      if (v.status != null) return ok(v.status);
      if (typeof v.result === 'string') return /pass/i.test(v.result);
      if ('valid' in v) return Boolean(v.valid);
    }
    return null;
  };
  const dkim = ok(payload.dkim);
  const spf = ok(payload.spf);
  const dmarc = ok(payload.dmarc);
  // Si no hay info de auth, no bloqueamos. Si la hay, exigimos al menos uno pass.
  if (dkim === null && spf === null && dmarc === null) return true;
  return dkim === true || spf === true || dmarc === true;
}

/** Aceptar el correo como fuente de pago válida: banco conocido + autenticado. */
export function isTrustedBankEmail(from, payload) {
  return isKnownBankSender(from) && passesAuth(payload);
}
