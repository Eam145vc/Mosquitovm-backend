// Integración con la API de ForwardEmail para crear un alias por cliente.
//
// Cada cliente del método "correo redirigido" recibe su propio alias <name>@sono.lat
// con DOS destinatarios: su correo real (reenvío del original) + el webhook del backend
// (para que suene el speaker). ForwardEmail manda a ambos a la vez, sin que el cliente
// tenga que verificar nada (a diferencia de Cloudflare).
//
// .env:
//   FE_API_TOKEN  - API token de ForwardEmail (Basic auth: token como usuario, pass vacío)
//   MAIL_DOMAIN   - sono.lat
//   PUBLIC_BASE_URL + EMAIL_WEBHOOK_SECRET - para armar la URL del webhook

import { config } from './config.js';
import { logger } from './logger.js';
import { randomBytes } from 'node:crypto';

const FE_API = 'https://api.forwardemail.net/v1';

function authHeader() {
  // Basic auth: usuario = token, password vacío.
  return 'Basic ' + Buffer.from(`${config.FE_API_TOKEN}:`).toString('base64');
}

/** URL del webhook (incluye el secreto) que recibe cada correo del alias. */
function webhookUrl() {
  const base = (config.PUBLIC_BASE_URL || 'https://api.sono.lat').replace(/\/$/, '');
  return `${base}/webhook/email-fe?key=${encodeURIComponent(config.EMAIL_WEBHOOK_SECRET)}`;
}

/** Genera un nombre de alias legible + sufijo aleatorio: "soyjuan@gmail.com" -> "soyjuan-k3f9". */
export function generateAlias(email) {
  const local = String(email || '').split('@')[0].toLowerCase()
    .replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'pagos';
  const suffix = randomBytes(3).toString('hex').slice(0, 4);
  return `${local}-${suffix}`;
}

/**
 * Crea el alias del cliente en ForwardEmail con recipients = [correoCliente, webhook].
 * Devuelve { ok, alias, id } o { ok:false, error }.
 * Si FE_API_TOKEN no está, devuelve { skipped:true } (el onboarding sigue, el catch-all
 * de fallback igual capta los correos por el webhook).
 */
export async function createClientAlias({ name, forwardTo }) {
  if (!config.FE_API_TOKEN) {
    logger.warn('forwardemail: FE_API_TOKEN no configurado, salteando creación de alias');
    return { skipped: true };
  }
  const recipients = [forwardTo, webhookUrl()].join(',');
  try {
    const params = new URLSearchParams({ name, recipients, is_enabled: 'true' });
    const resp = await fetch(`${FE_API}/domains/${config.MAIL_DOMAIN}/aliases`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await resp.json();
    if (resp.ok && data.id) {
      return { ok: true, alias: name, id: data.id };
    }
    // ¿ya existe? (nombre tomado) — lo tratamos como ok idempotente
    const exists = /exist|taken|duplicate/i.test(JSON.stringify(data.message || data));
    if (exists) return { ok: true, alias: name, alreadyExists: true };
    logger.warn({ name, status: resp.status, data }, 'forwardemail: createClientAlias fallo');
    return { ok: false, error: data.message || `HTTP ${resp.status}` };
  } catch (e) {
    logger.error({ name, err: e.message }, 'forwardemail: createClientAlias error');
    return { ok: false, error: e.message };
  }
}

/** Borra un alias por nombre (busca su id primero). Best-effort, no crítico. */
export async function deleteClientAlias(name) {
  if (!config.FE_API_TOKEN) return { skipped: true };
  try {
    const list = await fetch(`${FE_API}/domains/${config.MAIL_DOMAIN}/aliases?name=${encodeURIComponent(name)}`, {
      headers: { Authorization: authHeader() },
    });
    const arr = await list.json();
    const hit = Array.isArray(arr) ? arr.find((a) => a.name === name) : null;
    if (!hit) return { ok: true, notFound: true };
    const del = await fetch(`${FE_API}/domains/${config.MAIL_DOMAIN}/aliases/${hit.id}`, {
      method: 'DELETE',
      headers: { Authorization: authHeader() },
    });
    return { ok: del.ok };
  } catch (e) {
    logger.error({ name, err: e.message }, 'forwardemail: deleteClientAlias error');
    return { ok: false, error: e.message };
  }
}
