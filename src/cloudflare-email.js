// Integración con la API de Cloudflare Email Routing.
//
// Sirve para registrar el correo del cliente como "destination address" verificado,
// para que el Email Worker pueda reenviarle los correos del banco. Cloudflare le manda
// un mail de confirmación al cliente (1 clic) — eso no se puede saltar (anti-abuso).
//
// Necesita en .env:
//   CF_API_TOKEN     - token con permiso "Email Routing Addresses: Edit" (a nivel cuenta)
//   CF_ACCOUNT_ID    - id de la cuenta de Cloudflare
//
// Si no están configurados, las funciones no fallan: devuelven { skipped: true } para
// que el onboarding siga funcionando (el destino se puede verificar manual mientras tanto).

import { config } from './config.js';
import { logger } from './logger.js';
import { randomBytes } from 'node:crypto';

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Genera un alias legible + sufijo aleatorio: "soyjuan@gmail.com" -> "soyjuan-k3f9". */
export function generateAlias(email) {
  const local = String(email || '').split('@')[0].toLowerCase()
    .replace(/[^a-z0-9]+/g, '')      // solo alfanumérico
    .slice(0, 20) || 'pagos';        // fallback si queda vacío
  // sufijo de 4 chars base36 (sin caracteres ambiguos)
  const suffix = randomBytes(3).toString('hex').slice(0, 4);
  return `${local}-${suffix}`;
}

/**
 * Registra un correo como destination address en Cloudflare Email Routing.
 * Cloudflare le envía un mail de verificación al cliente.
 * Devuelve { ok, alreadyExists, verified, skipped }.
 */
export async function registerDestination(email) {
  if (!config.CF_API_TOKEN || !config.CF_ACCOUNT_ID) {
    logger.warn('cloudflare: CF_API_TOKEN/CF_ACCOUNT_ID no configurados, salteando registro');
    return { skipped: true };
  }
  try {
    const resp = await fetch(
      `${CF_API}/accounts/${config.CF_ACCOUNT_ID}/email/routing/addresses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      }
    );
    const data = await resp.json();
    if (resp.ok && data.success) {
      return { ok: true, verified: Boolean(data.result?.verified) };
    }
    // Código 1009 / mensaje "already exists" = el correo ya estaba registrado.
    const already = (data.errors || []).some(
      (e) => /exist/i.test(e.message || '') || e.code === 1009
    );
    if (already) {
      return { ok: true, alreadyExists: true };
    }
    logger.warn({ email, errors: data.errors }, 'cloudflare: registerDestination fallo');
    return { ok: false, errors: data.errors };
  } catch (e) {
    logger.error({ email, err: e.message }, 'cloudflare: registerDestination error');
    return { ok: false, error: e.message };
  }
}

/**
 * Consulta si un destino ya está verificado (el cliente hizo clic en el mail).
 * Devuelve { verified } o { skipped }.
 */
export async function isDestinationVerified(email) {
  if (!config.CF_API_TOKEN || !config.CF_ACCOUNT_ID) return { skipped: true };
  try {
    const resp = await fetch(
      `${CF_API}/accounts/${config.CF_ACCOUNT_ID}/email/routing/addresses?per_page=50`,
      { headers: { Authorization: `Bearer ${config.CF_API_TOKEN}` } }
    );
    const data = await resp.json();
    if (!resp.ok || !data.success) return { verified: false };
    const hit = (data.result || []).find(
      (a) => (a.email || '').toLowerCase() === String(email).toLowerCase()
    );
    return { verified: Boolean(hit && hit.verified) };
  } catch (e) {
    logger.error({ email, err: e.message }, 'cloudflare: isDestinationVerified error');
    return { verified: false };
  }
}
