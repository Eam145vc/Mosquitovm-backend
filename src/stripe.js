// Helper de Stripe — Checkout Session alojada (redirect), espejo del Checkout Pro
// de MercadoPago. Se usa mientras la cuenta de MercadoPago no procesa por API.
// Solo tarjetas. Montos en centavos COP (igual que amount_cents de las órdenes).

import { config } from './config.js';

const STRIPE_API = 'https://api.stripe.com/v1';

function authHeaders() {
  return {
    Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    // Versión fijada: ui_mode=embedded_page existe desde esta versión; sin el
    // header, cada cuenta usa su versión por defecto y el comportamiento cambia.
    'Stripe-Version': '2026-03-25.dahlia',
  };
}

/**
 * Crea una Checkout Session EMBEBIDA (ui_mode=embedded: el formulario de Stripe
 * se monta dentro de sono.lat, sin redirección). Devuelve el client_secret que
 * el front usa con initEmbeddedCheckout.
 */
export async function createStripeCheckout(orderId, amountCents) {
  if (!config.hasStripe) throw new Error('Stripe no configurado (STRIPE_SECRET_KEY)');
  const params = new URLSearchParams({
    mode: 'payment',
    ui_mode: 'embedded_page',
    'payment_method_types[0]': 'card',
    client_reference_id: orderId,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'cop',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][product_data][name]': 'Sonó · dispositivo y servicio',
    // Stripe reemplaza {CHECKOUT_SESSION_ID} al volver tras el pago.
    return_url: `https://sono.lat/activar-pro?order=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
  });
  const resp = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: authHeaders(),
    body: params,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.client_secret) {
    throw new Error(
      `Stripe checkout failed: HTTP ${resp.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`,
    );
  }
  return data.client_secret;
}

/** Consulta una Checkout Session (para verificar el pago al volver del redirect). */
export async function fetchStripeSession(sessionId) {
  if (!config.hasStripe) return null;
  const resp = await fetch(
    `${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
        'Stripe-Version': '2026-03-25.dahlia',
      },
    },
  );
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}
