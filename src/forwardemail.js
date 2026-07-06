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

// Dominio donde se crean los aliases en Forward Email. Con la arquitectura nueva
// (MX propio mx.sono.lat), el correo del banco llega a NUESTRO server, que lo reenvía
// a <alias>@fwd.sono.lat. Forward Email recibe ahí y lo entrega al correo del cliente.
// Por eso el alias se crea en fwd.sono.lat (no en sono.lat, cuyo MX ya es nuestro server).
function fwdDomain() {
  return config.FWD_DOMAIN || `fwd.${config.MAIL_DOMAIN}`;
}

function authHeader() {
  // Basic auth: usuario = token, password vacío.
  return 'Basic ' + Buffer.from(`${config.FE_API_TOKEN}:`).toString('base64');
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
  // Recipient = SOLO el correo del cliente. El webhook ya NO va acá: el MX propio
  // (mx.sono.lat) recibe del banco, llama al webhook y reenvía a este alias en fwd.
  const recipients = forwardTo;
  const domain = fwdDomain();
  try {
    const params = new URLSearchParams({ name, recipients, is_enabled: 'true' });
    const resp = await fetch(`${FE_API}/domains/${domain}/aliases`, {
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

/** Actualiza el DESTINO (recipients) de un alias existente SIN cambiar su nombre.
 *  Para el redo del onboarding: el alias que el cliente ya puso en su banco es
 *  inmutable; solo se corrige a dónde le llega su copia. Si el alias no existe en
 *  FE (se creó en modo catch-all), se crea con el destino nuevo. */
export async function updateClientAliasRecipients(name, forwardTo) {
  if (!config.FE_API_TOKEN) return { skipped: true };
  const domain = fwdDomain();
  try {
    const list = await fetch(`${FE_API}/domains/${domain}/aliases?name=${encodeURIComponent(name)}`, {
      headers: { Authorization: authHeader() },
    });
    const arr = await list.json();
    const hit = Array.isArray(arr) ? arr.find((a) => a.name === name) : null;
    if (!hit) return createClientAlias({ name, forwardTo });
    const params = new URLSearchParams({ recipients: forwardTo, is_enabled: 'true' });
    const resp = await fetch(`${FE_API}/domains/${domain}/aliases/${hit.id}`, {
      method: 'PUT',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (resp.ok) return { ok: true, alias: name, updated: true };
    const data = await resp.json().catch(() => ({}));
    return { ok: false, error: data.message || `HTTP ${resp.status}` };
  } catch (e) {
    logger.error({ name, err: e.message }, 'forwardemail: updateClientAliasRecipients error');
    return { ok: false, error: e.message };
  }
}

/** Borra un alias por nombre (busca su id primero). Best-effort, no crítico. */
export async function deleteClientAlias(name) {
  if (!config.FE_API_TOKEN) return { skipped: true };
  const domain = fwdDomain();
  try {
    const list = await fetch(`${FE_API}/domains/${domain}/aliases?name=${encodeURIComponent(name)}`, {
      headers: { Authorization: authHeader() },
    });
    const arr = await list.json();
    const hit = Array.isArray(arr) ? arr.find((a) => a.name === name) : null;
    if (!hit) return { ok: true, notFound: true };
    const del = await fetch(`${FE_API}/domains/${domain}/aliases/${hit.id}`, {
      method: 'DELETE',
      headers: { Authorization: authHeader() },
    });
    return { ok: del.ok };
  } catch (e) {
    logger.error({ name, err: e.message }, 'forwardemail: deleteClientAlias error');
    return { ok: false, error: e.message };
  }
}
