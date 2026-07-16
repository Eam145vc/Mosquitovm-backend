// Meta Conversions API (server-side). El Purchase del navegador (fbq en
// activar-client.tsx) solo dispara si el cliente abre /activar-pro con la orden:
// pestaña cerrada tras pagar (PSE/Nequi conciliados por job) o QR subido por el
// admin = venta que Meta nunca ve. Este job reporta esas compras desde el servidor
// con event_id = orderId — el MISMO eventID que manda el fbq del front — así Meta
// dedupea y una venta jamás cuenta doble.
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { listOrders, markOrderMetaCapi } from './storage.js';
import { logger } from './logger.js';

const GRAPH_URL = `https://graph.facebook.com/v21.0/${config.META_PIXEL_ID}/events`;

// Mismos estados "pagados" que http-server.js (isPaid); cod_pending además exige QR.
const PAID_STATES = ['paid', 'pendiente_qr', 'ready_to_ship', 'shipped'];
const DAY = 24 * 3600 * 1000;
// Meta rechaza eventos con más de 7 días; margen para no rozar el límite.
const MAX_AGE = 6.5 * DAY;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Teléfono colombiano → E.164 sin '+' (57XXXXXXXXXX), formato del user_data de Meta.
function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 && d.startsWith('3')) return `57${d}`;
  return d;
}

// Conversión = la MISMA regla del front (activar-client.tsx): online cuenta al
// quedar paga; contraentrega no se cobra online, cuenta al subir el QR.
export function isConverted(o) {
  if (!o || o.archived_at) return false;
  const paidish = PAID_STATES.includes(o.status) || o.status === 'cod_pending';
  if (!paidish) return false;
  return o.delivery !== 'contraentrega' || Boolean(o.qr_path);
}

// Momento real de la conversión cuando se puede derivar (mejora la atribución):
// next_charge_at se setea SOLO al aprobar el pago (+365d); COD usa updated_at
// (subir el QR es lo último que toca la orden antes de convertir). Fuera de la
// ventana que Meta acepta → ahora.
function eventTimeMs(o, now) {
  const est = o.next_charge_at ? o.next_charge_at - 365 * DAY : o.updated_at;
  if (est && est > now - MAX_AGE && est <= now) return est;
  return now;
}

async function sendPurchase(o, now) {
  const userData = { external_id: [sha256(o.id)] };
  const email = (o.customer_email || o.mp_payer_email || '').trim().toLowerCase();
  if (email) userData.em = [sha256(email)];
  const phone = normPhone(o.phone);
  if (phone) userData.ph = [sha256(phone)];

  const event = {
    event_name: 'Purchase',
    event_time: Math.floor(eventTimeMs(o, now) / 1000),
    event_id: o.id, // = eventID del fbq del front → dedupe navegador/servidor
    action_source: 'website',
    event_source_url: 'https://sonoback.com/activar-pro',
    user_data: userData,
  };
  // Meta exige value > 0; una orden sin monto (anómala) va sin custom_data antes
  // que ensuciar la calidad del evento con value=0.
  const value = Math.round((o.amount_cents || 0) / 100);
  if (value > 0) event.custom_data = { currency: 'COP', value };

  const body = { data: [event], access_token: config.META_CAPI_TOKEN };
  if (config.META_CAPI_TEST_CODE) body.test_event_code = config.META_CAPI_TEST_CODE;

  const res = await fetch(GRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.error) throw new Error(out.error?.message || `HTTP ${res.status}`);
  return out;
}

// Barrido idempotente: toda orden convertida con actividad en los últimos 7 días y
// sin meta_capi_at se reporta (de a una: una orden con datos raros no envenena al
// resto) y se marca. Cubre TODOS los caminos —webhook EfiPay, conciliación, Bre-B
// propio, QR subido por el cliente O por el admin— sin enganchar cada endpoint.
export async function reportPurchasesToMeta() {
  if (!config.hasMetaCapi) return 0;
  const now = Date.now();
  const due = listOrders().filter((o) =>
    !o.meta_capi_at && (o.updated_at || 0) > now - MAX_AGE && isConverted(o));
  let sent = 0;
  for (const o of due) {
    try {
      await sendPurchase(o, now);
      markOrderMetaCapi(o.id);
      sent += 1;
      logger.info({ orderId: o.id, value: Math.round((o.amount_cents || 0) / 100) },
        'meta-capi: Purchase reportado');
    } catch (e) {
      // sin marcar → reintenta en el próximo ciclo
      logger.warn({ orderId: o.id, err: e.message }, 'meta-capi: fallo al reportar (reintenta)');
    }
  }
  return sent;
}
