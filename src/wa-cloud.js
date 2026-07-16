// WhatsApp Cloud API OFICIAL (Meta Graph). Tercer y definitivo enviador: corre en
// la VM, sin sesión vinculada ni QR (no existe device_removed), con estado de
// entrega REAL vía webhook. Business-initiated exige PLANTILLAS pre-aprobadas
// (src/wa-templates.js); acá vive el mapeo kind→payload y el loop de envío.
// La cola wa_outbox y wa-enqueue no cambian.
//
// Activación en dos pasos (failsafe): las env vars WA_CLOUD_* encienden el módulo,
// pero SOLO se vuelve el enviador real (isWaCloudActive() → /wa/pending le corta la
// cola al agente PC) cuando verificó contra Meta que TODAS las plantillas están
// APROBADAS. Con plantillas pendientes el agente PC sigue operando — nunca se quema
// la cola contra plantillas inexistentes.
//
// ⚠️ Regresión conocida v1 (documentada, pendiente): el kind 'envio' NO adjunta el
// PDF de la guía como hacía el agente PC (Cloud API exige plantilla con header
// DOCUMENT, cuya creación necesita subir un asset de ejemplo). El link de rastreo
// va en guia_creada; el PDF vendrá con una plantilla sono_guia_pdf futura.

import { config } from './config.js';
import { logger } from './logger.js';
import {
  claimWaPending, markWaSent, getWaSettings, touchWaAgent, countWaSentSince,
  getShipmentByOrder, getOrder,
} from './storage.js';
import { bogotaHour, startOfBogotaDay, withinActiveHours, randDelay, sleep } from './wa-shared.js';
import { moneyCo, esCodPendiente, firstNameOf } from './wa-enqueue.js';
import { WA_TEMPLATES } from './wa-templates.js';

const TICK_MS = 20 * 1000;
const BATCH = 5;
const TEMPLATE_RECHECK_MS = 10 * 60 * 1000;

// Solo estos kinds necesitan datos del shipment; el resto no paga el SELECT.
const KINDS_CON_SHIPMENT = new Set(['guia_creada', 'reparto', 'intento_entrega']);

// ── Builder puro: (order, kind, shipment) → payload de /messages ───────────────

// Las variables de plantilla no admiten \n, \t ni 4+ espacios seguidos.
export function sanitizeParam(v, fallback = '-') {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s || fallback;
}

function trackingDe(shipment, carrier) {
  return sanitizeParam(shipment?.tracking_url, `la web de ${carrier} con tu número de guía`);
}

/** Arma el payload de plantilla para un kind. Devuelve null si el kind no tiene
 *  plantilla (el enviador lo marca failed con error claro, nunca inventa texto). */
export function buildWaCloudPayload(order, kind, shipment = null) {
  const nombre = sanitizeParam(firstNameOf(order), 'cliente');
  const btn = (name) => WA_TEMPLATES[name].button
    ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: order.id }] }]
    : [];
  const tpl = (name, params) => ({
    name,
    language: { code: 'es' },
    components: [
      { type: 'body', parameters: params.map((p) => ({ type: 'text', text: sanitizeParam(p) })) },
      ...btn(name),
    ],
  });

  if (kind === 'activacion') return tpl('sono_activacion', [nombre]);
  if (kind === 'recordatorio_3h' || kind === 'recordatorio_24h') {
    return tpl('sono_recordatorio_qr', [nombre]);
  }
  if (kind === 'guia_creada') {
    const guia = sanitizeParam(shipment?.tracking, 'en camino');
    const carrier = sanitizeParam(shipment?.carrier, 'la transportadora');
    const destinatario = sanitizeParam(order.business_name, 'sin nombre');
    const direccion = sanitizeParam(
      [order.address, order.city].filter(Boolean).join(', '), 'sin dirección');
    const rastreo = trackingDe(shipment, carrier);
    return esCodPendiente(order)
      ? tpl('sono_guia_creada_cod', [nombre, guia, carrier, destinatario, direccion, moneyCo(order.amount_cents), rastreo])
      : tpl('sono_guia_creada', [nombre, guia, carrier, destinatario, direccion, rastreo]);
  }
  if (kind === 'envio') return tpl('sono_en_camino', [nombre]);
  if (kind === 'reparto') {
    const carrier = sanitizeParam(shipment?.carrier, 'la transportadora');
    const rastreo = trackingDe(shipment, carrier);
    return esCodPendiente(order)
      ? tpl('sono_reparto_cod', [nombre, moneyCo(order.amount_cents), rastreo])
      : tpl('sono_reparto', [nombre, rastreo]);
  }
  if (kind === 'intento_entrega') {
    const carrier = sanitizeParam(shipment?.carrier, 'la transportadora');
    return tpl('sono_intento_entrega', [nombre, trackingDe(shipment, carrier)]);
  }
  if (kind === 'entregado') return tpl('sono_entregado', [nombre]);
  if (kind === 'correo') return tpl('sono_correo', [nombre]);
  if (kind === 'libreta') return tpl('sono_libreta', [nombre]);
  return null;
}

// ── Cliente Graph ──────────────────────────────────────────────────────────────

async function graph(path, init = {}) {
  const r = await fetch(`https://graph.facebook.com/${config.WA_CLOUD_GRAPH_VERSION}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.WA_CLOUD_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`graph: ${data?.error?.message || `HTTP ${r.status}`}`);
    // 5xx/429 = Meta con problemas o rate limit → transitorio: el mensaje queda
    // 'sending' y requeueStaleWa lo devuelve a la cola; 4xx = definitivo → failed.
    err.transient = r.status >= 500 || r.status === 429;
    throw err;
  }
  return data;
}

async function graphSend(phone, template) {
  const data = await graph(`/${config.WA_CLOUD_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'template', template }),
  });
  return data?.messages?.[0]?.id || null; // wamid
}

// ── Verificación de plantillas y estado activo ─────────────────────────────────

let active = false;

/** true = wa-cloud ES el enviador (plantillas verificadas). Lo consulta el guard
 *  de /wa/pending: mientras sea false, el agente de la PC sigue drenando. */
export function isWaCloudActive() {
  return active;
}

async function verifyTemplates() {
  if (!config.WA_CLOUD_WABA_ID) {
    // Sin WABA_ID no se puede verificar: se activa igual (decisión del operador),
    // avisando que el failsafe de plantillas queda apagado.
    logger.warn('wa-cloud: sin WA_CLOUD_WABA_ID no se verifica el estado de las plantillas; activando a ciegas');
    active = true;
    return;
  }
  try {
    const data = await graph(`/${config.WA_CLOUD_WABA_ID}/message_templates?fields=name,status&limit=200`);
    const estados = new Map((data.data || []).map((t) => [t.name, t.status]));
    const faltantes = Object.keys(WA_TEMPLATES).filter((n) => estados.get(n) !== 'APPROVED');
    if (faltantes.length === 0) {
      if (!active) logger.info('wa-cloud: todas las plantillas APROBADAS — enviador ACTIVO');
      active = true;
      return;
    }
    active = false;
    logger.error({ faltantes }, 'wa-cloud: plantillas sin aprobar — el agente PC sigue a cargo; reintento en 10 min');
  } catch (e) {
    active = false;
    logger.error({ err: e.message }, 'wa-cloud: no se pudo verificar plantillas — reintento en 10 min');
  }
}

// ── Loop de envío ──────────────────────────────────────────────────────────────

let running = false;

async function tick() {
  if (!active || running) return;
  running = true;
  try {
    const s = getWaSettings();
    if (!s.enabled) return; // apagado remoto desde el panel /admin
    if (!withinActiveHours(bogotaHour(), s.active_hour_start, s.active_hour_end)) return;
    // Tope diario contra la DB. Cuenta por sent_at (no por status): un mensaje
    // enviado que el webhook luego marque failed IGUAL consumió cupo del día.
    const sentToday = countWaSentSince(startOfBogotaDay());
    if (sentToday >= s.daily_cap) return;
    touchWaAgent(); // heartbeat del panel: solo late cuando el enviador puede enviar
    const messages = claimWaPending(Math.min(BATCH, s.daily_cap - sentToday));
    let first = true;
    for (const m of messages) {
      // Delay anti-patrón ENTRE envíos; el primero sale ya (el tick de 20s ya espacia).
      if (!first) await sleep(randDelay(s.min_delay_ms, s.max_delay_ms));
      first = false;
      try {
        const order = getOrder(m.order_id);
        if (!order) throw new Error('orden no existe');
        const shipment = KINDS_CON_SHIPMENT.has(m.kind) ? getShipmentByOrder(m.order_id) : null;
        const template = buildWaCloudPayload(order, m.kind, shipment);
        if (!template) throw new Error(`kind sin plantilla: ${m.kind}`);
        const wamid = await graphSend(m.phone, template);
        // Una sola escritura: status y wamid juntos, para que el webhook de Meta
        // (que puede llegar en milisegundos) siempre encuentre la fila por wamid.
        markWaSent(m.id, true, null, wamid);
        logger.info({ phone: m.phone, kind: m.kind, wamid }, 'wa-cloud: aceptado por Meta');
      } catch (e) {
        if (e.transient) {
          // Queda 'sending'; requeueStaleWa (index.js) lo devuelve a 'queued' en ~30 min.
          logger.warn({ phone: m.phone, kind: m.kind, err: e.message }, 'wa-cloud: error transitorio, se reintentará');
        } else {
          markWaSent(m.id, false, e.message);
          logger.error({ phone: m.phone, kind: m.kind, err: e.message }, 'wa-cloud: fallo definitivo');
        }
      }
    }
  } catch (e) {
    logger.error({ err: e.message }, 'wa-cloud: tick error');
  } finally {
    running = false;
  }
}

export function startWaCloudSender() {
  if (!config.hasWaCloud) return false;
  if (config.hasEvolution) {
    logger.error('wa-cloud: EVOLUTION_* y WA_CLOUD_* configurados a la vez — gana la Cloud API (borrar EVOLUTION_* del .env)');
  }
  verifyTemplates();
  setInterval(verifyTemplates, TEMPLATE_RECHECK_MS);
  setInterval(tick, TICK_MS);
  logger.info({ phoneId: config.WA_CLOUD_PHONE_NUMBER_ID }, 'wa-cloud: configurado (verificando plantillas antes de activar)');
  return true;
}
