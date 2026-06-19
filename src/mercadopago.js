// Helper de MercadoPago - pago IN-WEB con Bricks (tarjeta tokenizada en el front) +
// guardado de la tarjeta (Customers/Cards) para re-cobrar la renovación anual.
//
// Flujo:
//   1. El front (Bricks) tokeniza la tarjeta y manda { token, payment_method_id, installments,
//      issuer_id, payer:{ email, identification } } a /checkout/pay.
//   2. createPayment(...) cobra una vez con ese token (/v1/payments). external_reference = orderId.
//   3. Si aprueba, guardamos la tarjeta (getOrCreateCustomer + saveCard) para el re-cobro del
//      año siguiente, y agendamos next_charge_at.
//
// Nota: en COP transaction_amount va en PESOS (amountCents/100).

import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const MP_API = 'https://api.mercadopago.com';

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${config.MP_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * Procesa un pago con el formData que entrega el Payment Brick (tarjeta, PSE, Nequi, Efecty…).
 * Reenviamos el formData a /v1/payments pero FORZAMOS el monto y la referencia desde el backend
 * (nunca confiamos en el monto que manda el cliente). Devuelve el objeto payment completo, que
 * puede traer una URL de redirección (PSE) o de cupón (efectivo).
 */
export async function forwardPayment(orderId, amountCents, formData = {}, clientIp = null, order = null) {
  if (!config.hasMp) throw new Error('MercadoPago no configurado (MP_ACCESS_TOKEN)');
  const amount = Math.round(amountCents / 100); // COP en pesos
  const body = {
    ...formData,
    transaction_amount: amount, // override de seguridad: nunca confiar en el monto del cliente
    external_reference: orderId,
    description: 'Sonó · servicio anual',
    // PSE exige additional_info.ip_address en Colombia; en tarjetas suma para
    // el antifraude/ruteo. items ayuda a la tasa de aprobación.
    additional_info: {
      ...(formData.additional_info || {}),
      ...(clientIp ? { ip_address: clientIp } : {}),
      items: [
        { id: 'sono', title: 'Sonó · dispositivo y servicio', quantity: 1, unit_price: amount },
      ],
    },
  };

  // Antifraude: nombre/teléfono/dirección del pagador en additional_info suben
  // el score de aprobación en tarjetas (doc "cómo mejorar la aprobación").
  if (order) {
    const fullName = String(order.business_name || '').trim();
    const [firstName, ...restName] = fullName.split(/\s+/);
    const phoneDigits = String(order.phone || '').replace(/\D/g, '');
    body.additional_info.payer = {
      ...(firstName ? { first_name: firstName, last_name: restName.join(' ') || firstName } : {}),
      ...(phoneDigits
        ? { phone: { area_code: phoneDigits.slice(0, 3), number: phoneDigits.slice(3, 10) } }
        : {}),
      ...(order.address ? { address: { street_name: String(order.address).trim() } } : {}),
    };
  }

  // PSE "nueva versión" (doc integrate-pse-avanza): el payer debe ir COMPLETO
  // (nombre, dirección de 6 campos, teléfono) + callback_url + notification_url;
  // sin esto la API responde 424 "BankTransfers Api fail". El Brick solo manda
  // email/identification/entity_type/banco — completamos con los datos de envío
  // de la orden (best-effort: MP valida presencia, no exactitud postal).
  if (formData.payment_method_id === 'pse') {
    const fullName = String(order?.business_name || 'Cliente Sono').trim();
    const [firstName, ...restName] = fullName.split(/\s+/);
    const phoneDigits = String(order?.phone || '').replace(/\D/g, '');
    const city = String(order?.city || 'Bogotá').trim() || 'Bogotá';
    const street = String(order?.address || 'No informado').trim() || 'No informado';
    body.payer = {
      ...body.payer,
      first_name: firstName,
      last_name: restName.join(' ') || firstName,
      phone: {
        area_code: phoneDigits.slice(0, 3) || '300',
        number: phoneDigits.slice(3, 10) || '0000000',
      },
      address: {
        zip_code: '110111',
        street_name: street,
        street_number: (street.match(/\d+/) || ['1'])[0],
        neighborhood: city,
        city,
        federal_unit: city,
      },
    };
    body.callback_url = `https://sono.lat/activar-pro?order=${orderId}`; // a dónde volver después del banco
    body.notification_url = 'https://api.sono.lat/webhook/mp';
  }

  const resp = await fetch(`${MP_API}/v1/payments`, {
    method: 'POST',
    headers: authHeaders({ 'X-Idempotency-Key': randomUUID() }),
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`MP payment failed: HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data; // { status, status_detail, id, point_of_interaction, transaction_details, ... }
}

/**
 * Crea una preferencia de Checkout Pro y devuelve el init_point (URL de pago alojada).
 * Se usa porque la cuenta MP actual NO tiene habilitado el procesamiento directo por
 * API (/v1/payments responde 412 código 9510 "Payment router cannot find route" y PSE
 * 424 "BankTransfers Api fail"), pero Checkout Pro SÍ rutea todos los métodos.
 */
export async function createPreference(orderId, amountCents) {
  if (!config.hasMp) throw new Error('MercadoPago no configurado (MP_ACCESS_TOKEN)');
  const amount = Math.round(amountCents / 100); // COP en pesos
  const wizard = `https://sono.lat/activar-pro?order=${orderId}`;
  const body = {
    items: [
      { id: 'sono', title: 'Sonó · dispositivo y servicio', quantity: 1, unit_price: amount, currency_id: 'COP' },
    ],
    external_reference: orderId,
    back_urls: { success: wizard, pending: wizard, failure: `https://sono.lat/checkout?pago=fallido` },
    auto_return: 'approved',
    notification_url: 'https://api.sono.lat/webhook/mp',
    statement_descriptor: 'SONO',
  };
  const resp = await fetch(`${MP_API}/checkout/preferences`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.init_point) {
    throw new Error(`MP preference failed: HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.init_point;
}

/** URL a la que hay que llevar al cliente para completar (PSE → banco, efectivo → cupón). */
export function paymentRedirectUrl(payment) {
  return (
    payment?.point_of_interaction?.transaction_data?.ticket_url ||
    payment?.transaction_details?.external_resource_url ||
    null
  );
}

/** Busca el customer por email o lo crea. Devuelve el customerId (o null si falla). */
export async function getOrCreateCustomer(email) {
  if (!config.hasMp || !email) return null;
  try {
    const s = await fetch(`${MP_API}/v1/customers/search?email=${encodeURIComponent(email)}`, {
      headers: authHeaders(),
    });
    const sj = await s.json().catch(() => ({}));
    if (sj?.results?.length) return sj.results[0].id;

    const c = await fetch(`${MP_API}/v1/customers`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ email }),
    });
    const cj = await c.json().catch(() => ({}));
    return cj?.id || null;
  } catch {
    return null;
  }
}

/** Guarda la tarjeta tokenizada en el customer. Devuelve el cardId (o null si falla). */
export async function saveCard(customerId, token) {
  if (!config.hasMp || !customerId || !token) return null;
  try {
    const r = await fetch(`${MP_API}/v1/customers/${customerId}/cards`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token }),
    });
    const j = await r.json().catch(() => ({}));
    return j?.id || null;
  } catch {
    return null;
  }
}

/** Consulta un pago por id. */
export async function fetchPayment(id) {
  if (!config.hasMp) return null;
  const resp = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(id)}`, { headers: authHeaders() });
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

/** Extrae el id de pago de una notificación de webhook (varios formatos de MP). */
export function paymentIdFromWebhook(req) {
  const q = req.query || {};
  const b = req.body || {};
  const type = q.type || b.type || q.topic || b.topic || '';
  if (String(type).includes('payment')) {
    return q['data.id'] || b?.data?.id || q.id || b.id || null;
  }
  return b?.data?.id || q['data.id'] || null;
}
