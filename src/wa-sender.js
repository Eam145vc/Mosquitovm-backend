// Enviador de WhatsApp EN LA VM vía Evolution API (Baileys). Reemplaza al agente
// de la PC del dueño (wa-agent con whatsapp-web.js): la cola wa_outbox, los textos
// y el dedupe NO cambian; solo cambia quién la drena. Mantiene las mismas guardas
// anti-ban del agente: switch enabled del panel /admin, horario activo (hora
// Bogotá), tope diario y delay aleatorio entre mensajes.
// Si EVOLUTION_API_URL/KEY no están configurados, no arranca y el agente de la PC
// sigue funcionando por polling como siempre.

import { config } from './config.js';
import { logger } from './logger.js';
import {
  claimWaPending, markWaSent, getWaSettings, touchWaAgent, countWaSentSince,
  getShipmentByOrder, updateShipmentRow,
} from './storage.js';
import { getShipment, extractLabel, fetchLabelPdf } from './skydropx.js';

const TICK_MS = 20 * 1000;
const BATCH = 5; // igual que el agente: máx 5 mensajes por pasada

// Colombia es UTC-5 fijo (sin DST): la hora local sale con offset plano, sin Intl.
const BOGOTA_OFFSET_MS = 5 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export function bogotaHour(now = Date.now()) {
  return Math.floor(((now - BOGOTA_OFFSET_MS) % DAY_MS) / (3600 * 1000));
}

export function startOfBogotaDay(now = Date.now()) {
  return Math.floor((now - BOGOTA_OFFSET_MS) / DAY_MS) * DAY_MS + BOGOTA_OFFSET_MS;
}

export function withinActiveHours(hour, start, end) {
  return hour >= start && hour < end; // fin exclusivo, igual que el agente
}

export function randDelay(min, max, rnd = Math.random) {
  return Math.floor(min + (max - min) * rnd());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evo(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${config.EVOLUTION_API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: config.EVOLUTION_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`evolution ${path} -> ${r.status} ${text.slice(0, 200)}`);
  }
  return r.json().catch(() => ({}));
}

// Sin sesión de WhatsApp vinculada (QR sin escanear, teléfono sin red) no se
// reclaman mensajes: quedan 'queued' y salen solos cuando la sesión vuelva.
async function connectionOpen() {
  try {
    const d = await evo(`/instance/connectionState/${config.EVOLUTION_INSTANCE}`);
    return d?.instance?.state === 'open';
  } catch (e) {
    logger.warn({ err: e.message }, 'wa-sender: connectionState falló');
    return false;
  }
}

async function sendText(phone, text) {
  await evo(`/message/sendText/${config.EVOLUTION_INSTANCE}`, {
    method: 'POST',
    body: { number: phone, text },
  });
}

// Baja el PDF de la guía (mismo flujo que GET /wa/label/:orderId). Nunca lanza:
// el texto ya salió, el adjunto es best-effort igual que en el agente de la PC.
async function labelPdfBase64(orderId) {
  try {
    const row = getShipmentByOrder(orderId);
    if (!row || !row.skydropx_id || !config.hasSkydropx) return null;
    const label = extractLabel(await getShipment(row.skydropx_id));
    if (!label.labelUrl) return null;
    if (label.labelUrl !== row.label_url) updateShipmentRow(row.id, { label_url: label.labelUrl });
    const pdf = await fetchLabelPdf(label.labelUrl);
    return Buffer.from(pdf).toString('base64');
  } catch (e) {
    logger.warn({ orderId, err: e.message }, 'wa-sender: no se pudo bajar la guía para adjuntar');
    return null;
  }
}

let running = false;

async function tick() {
  if (running) return; // un tick a la vez: los delays aleatorios pueden superar TICK_MS
  running = true;
  try {
    const s = getWaSettings();
    if (!s.enabled) return; // apagado remoto desde el panel /admin
    if (!withinActiveHours(bogotaHour(), s.active_hour_start, s.active_hour_end)) return;
    // Tope diario contra la DB (sent_at de hoy, día Bogotá): sobrevive reinicios
    // de pm2, a diferencia del contador en memoria del agente viejo.
    const sentToday = countWaSentSince(startOfBogotaDay());
    if (sentToday >= s.daily_cap) return;
    if (!(await connectionOpen())) return;
    touchWaAgent(); // heartbeat del panel /admin: el "agente" ahora es este job
    const messages = claimWaPending(Math.min(BATCH, s.daily_cap - sentToday));
    for (const m of messages) {
      await sleep(randDelay(s.min_delay_ms, s.max_delay_ms));
      try {
        await sendText(m.phone, m.body);
        // kind='envio': adjuntar el PDF de la guía, igual que hacía el agente de la PC.
        if (m.kind === 'envio' && m.order_id) {
          const b64 = await labelPdfBase64(m.order_id);
          if (b64) {
            await evo(`/message/sendMedia/${config.EVOLUTION_INSTANCE}`, {
              method: 'POST',
              body: {
                number: m.phone,
                mediatype: 'document',
                mimetype: 'application/pdf',
                fileName: 'guia.pdf',
                media: b64,
                caption: '📄 Por favor confirma que todos los datos de envío se encuentren correctos.',
              },
            }).catch((e) => logger.warn({ orderId: m.order_id, err: e.message }, 'wa-sender: adjunto de guía falló'));
          }
        }
        markWaSent(m.id, true);
        logger.info({ phone: m.phone, kind: m.kind }, 'wa-sender: enviado');
      } catch (e) {
        markWaSent(m.id, false, e.message);
        logger.error({ phone: m.phone, kind: m.kind, err: e.message }, 'wa-sender: fallo enviando');
      }
    }
  } catch (e) {
    logger.error({ err: e.message }, 'wa-sender: tick error');
  } finally {
    running = false;
  }
}

export function startWaSender() {
  if (!config.hasEvolution) return false;
  setInterval(tick, TICK_MS);
  logger.info({ url: config.EVOLUTION_API_URL, instance: config.EVOLUTION_INSTANCE }, 'wa-sender: activo (Evolution API en la VM)');
  return true;
}
