// Helper de EfiPay (pasarela colombiana, comercio 5498). Dos caminos de cobro:
//
//  A) PAGO ÚNICO por LINK (generatePaymentLink): un POST a /generate-payment con
//     checkout_type:"redirect" devuelve una URL alojada por EfiPay que acepta TODOS
//     los métodos (tarjeta, PSE, Nequi, Bre-B, efectivo). Se usa para clientes que NO
//     pagan con tarjeta → renovación manual (les mandamos el link cada ciclo).
//
//  B) SUSCRIPCIÓN por TARJETA (createSubscription): liga un plan + suscriptor + tarjeta
//     tokenizada → EfiPay cobra automático cada ciclo. SOLO funciona con tarjeta
//     (PSE/Nequi/efectivo no se pueden debitar solos). Se usa cuando el cliente paga
//     con tarjeta y acepta el cobro recurrente.
//
// Auth: header Authorization: Bearer <token>. El token sale del panel
// (Desarrollador API key). Host real de la pasarela: https://sag.efipay.co
// office = ID de sucursal del comercio (Principal = 6055).
//
// Montos: EfiPay maneja COP en PESOS enteros (no centavos). Internamente Sonó guarda
// centavos, así que dividimos /100 al mandar.

import { config } from './config.js';

const EFI_API = 'https://sag.efipay.co/api/v1';

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${config.EFIPAY_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function efiPost(path, body, attempt = 1) {
  const resp = await fetch(`${EFI_API}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // EfiPay devuelve 422 "currency_type obligatorio" de forma INTERMITENTE aunque el
    // body sea correcto (glitch/rate-limit del servidor). Reintentamos hasta 3 veces
    // ante 422/429/5xx antes de fallar, así un hipo no tumba el checkout.
    const retryable = resp.status === 422 || resp.status === 429 || resp.status >= 500;
    if (retryable && attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return efiPost(path, body, attempt + 1);
    }
    throw new Error(`EfiPay ${path} HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

// ───────────────────────── A) PAGO ÚNICO POR LINK ─────────────────────────

/**
 * Genera un link de pago alojado (todos los métodos). Devuelve { paymentId, url }.
 * `amountCents` en centavos COP (se convierte a pesos). `orderId` se usa como
 * referencia para conciliar con el webhook.
 */
export async function generatePaymentLink(orderId, amountCents, description = 'Sonó · servicio') {
  if (!config.hasEfipay) throw new Error('EfiPay no configurado (EFIPAY_TOKEN)');
  const amount = Math.round(amountCents / 100); // COP en pesos
  const data = await efiPost('/payment/generate-payment', {
    payment: {
      description,
      amount,
      currency_type: 'COP',
      checkout_type: 'redirect',
    },
    advanced_options: {
      references: [orderId], // para conciliar el pago con la orden
      result_urls: {
        approved: `${config.FRONTEND_BASE_URL}/activar-pro?order=${orderId}`,
        pending: `${config.FRONTEND_BASE_URL}/activar-pro?order=${orderId}`,
        rejected: `${config.FRONTEND_BASE_URL}/checkout?pago=fallido`,
      },
    },
    office: config.EFIPAY_OFFICE,
  });
  return { paymentId: data.payment_id, url: data.url };
}

/**
 * Cobro EMBEBIDO con tarjeta (flujo `api` de 2 pasos, server-to-server):
 *   1. generate-payment checkout_type:"api" → devuelve { payment_id, token }
 *   2. transaction-checkout con esos 2 + customer_payer (dirección completa) + payment_card
 *
 * El número de tarjeta viaja por nuestro backend (EfiPay no tiene SDK de tokenización en
 * el navegador), así que este endpoint maneja datos PCI: NO loguear `card` jamás.
 *
 * `amountCents` en centavos COP. `card` = { holder, number, datetime:'yyyy-mm', cvv,
 * idType, idNumber, installments, phone }. `payer` = { name, email, country, state,
 * city, address1, address2, zipCode }. `browser` = browser_information del front (3DS).
 *
 * Devuelve { status, approved, transactionId, redirect } — redirect != null si EfiPay
 * pide continuar el 3DS en una URL.
 */
export async function chargeCard(orderId, amountCents, card, payer, browser = null, description = 'Sonó · servicio') {
  if (!config.hasEfipay) throw new Error('EfiPay no configurado (EFIPAY_TOKEN)');
  const amount = Math.round(amountCents / 100); // COP en pesos

  // Paso 1: generar el payment (api) → payment_id + token de un solo uso.
  const gen = await efiPost('/payment/generate-payment', {
    payment: { description, amount, currency_type: 'COP', checkout_type: 'api' },
    advanced_options: { references: [orderId] },
    office: config.EFIPAY_OFFICE,
  });
  if (!gen.payment_id || !gen.token) {
    throw new Error(`EfiPay generate-payment sin id/token: ${JSON.stringify(gen).slice(0, 200)}`);
  }

  // Paso 2: checkout con la tarjeta. NO reintentamos este POST (cobraría doble).
  const body = {
    payment: { id: gen.payment_id, token: gen.token },
    customer_payer: {
      name: payer.name,
      email: payer.email,
      country: payer.country || 'COL',
      state: payer.state || 'Bogota',
      city: payer.city || 'Bogota',
      address_1: payer.address1 || 'No informado',
      address_2: payer.address2 || payer.address1 || 'No informado',
      zip_code: payer.zipCode || '110111',
    },
    payment_card: {
      number: String(card.number).replace(/\s/g, ''),
      name: card.holder,
      expiration_date: card.datetime, // yyyy-mm
      cvv: String(card.cvv),
      identification_type: card.idType || 'CC',
      id_number: String(card.idNumber),
      installments: String(card.installments || '1'),
      dialling_code: '+57',
      cellphone: String(card.phone || '').replace(/\D/g, '') || '3000000000',
    },
  };
  if (browser) body.browser_information = browser;

  const resp = await fetch(`${EFI_API}/payment/transaction-checkout`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // Mensaje sin datos de tarjeta (PCI): solo el detalle de validación de EfiPay.
    throw new Error(`EfiPay checkout HTTP ${resp.status}: ${JSON.stringify(data.errors || data.message || data).slice(0, 300)}`);
  }
  const tx = data.transaction || {};
  const status = tx.status || data.status || null;
  const approved = /aprob|approv/i.test(String(status || ''));
  // 3DS: si EfiPay devuelve un paso de autenticación, hay que llevar al cliente ahí.
  const redirect = data['3Ds']?.centinelapistag || tx.url_response || null;
  return { status, approved, transactionId: tx.transaction_id || null, redirect, raw: data };
}

/**
 * Genera el payment tipo "api" (paso 1 común a PSE/Bre-B/efectivo) → {payment_id, token}.
 * El customer_payer base lo arma el caller. Devuelve los ids para el paso 2.
 */
async function generateApiPayment(orderId, amountCents, description) {
  const amount = Math.round(amountCents / 100);
  const gen = await efiPost('/payment/generate-payment', {
    payment: { description, amount, currency_type: 'COP', checkout_type: 'api' },
    advanced_options: { references: [orderId] },
    office: config.EFIPAY_OFFICE,
  });
  if (!gen.payment_id || !gen.token) {
    throw new Error(`EfiPay generate-payment sin id/token: ${JSON.stringify(gen).slice(0, 200)}`);
  }
  return gen;
}

/** POST de checkout sin reintento (no se reintenta un cobro). Devuelve {ok, data, status}. */
async function checkoutPost(path, body) {
  const resp = await fetch(`${EFI_API}${path}`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`EfiPay ${path} HTTP ${resp.status}: ${JSON.stringify(data.errors || data.message || data).slice(0, 300)}`);
  }
  return data;
}

/** Saca {status, approved, transactionId, redirect, qr} de una respuesta de checkout. */
function readCheckoutResult(data) {
  const tx = data.transaction || {};
  const status = tx.status || data.status || null;
  const approved = /aprob|approv/i.test(String(status || ''));
  // PSE → URL del banco; Bre-B → QR (embebible); efectivo → cupón.
  const redirect =
    data.url || data.redirect || tx.url_bank || tx.bank_url ||
    data.pse?.bankURL || tx.url_response || null;
  // Bre-B: qr_breb.qr_code_image (data URI/PNG) o qr_code_data (string EMVCo) para
  // mostrar el QR DENTRO de sono.lat. En modo test vienen null (solo producción).
  const qrSrc = data.qr_breb || tx.qr_breb || {};
  const qr = (qrSrc.qr_code_image || qrSrc.qr_code_data)
    ? { image: qrSrc.qr_code_image || null, data: qrSrc.qr_code_data || null }
    : null;
  return { status, approved, transactionId: tx.transaction_id || null, redirect, qr, raw: data };
}

/**
 * Cobro PSE embebido. `pse` = { financialInstitutionCode, userType('person'|'company'),
 * identificationType, identificationNumber, fullName, cellphoneNumber, address, email }.
 * Devuelve redirect = URL del banco (el resultado final llega por webhook).
 */
export async function chargePse(orderId, amountCents, payer, pse, description = 'Sonó · servicio') {
  if (!config.hasEfipay) throw new Error('EfiPay no configurado (EFIPAY_TOKEN)');
  const gen = await generateApiPayment(orderId, amountCents, description);
  const data = await checkoutPost('/payment/transaction-checkout/pse', {
    payment: { id: gen.payment_id, token: gen.token },
    customer_payer: { name: payer.name, email: payer.email },
    pse: {
      financialInstitutionCode: String(pse.financialInstitutionCode),
      userType: pse.userType || 'person',
      identificationType: pse.identificationType || 'CedulaDeCiudadania',
      identificationNumber: String(pse.identificationNumber),
      fullName: pse.fullName || payer.name,
      cellphoneNumber: String(pse.cellphoneNumber || '').replace(/\D/g, ''),
      address: pse.address || 'No informado',
      email: pse.email || payer.email,
      redirect: `${config.FRONTEND_BASE_URL}/activar-pro?order=${orderId}`,
    },
  });
  return readCheckoutResult(data);
}

/**
 * Cobro Bre-B embebido. Genera un QR/push a la app del banco vigente 30 min.
 * `cellphone` = celular del pagador. El resultado final llega por webhook.
 */
export async function chargeBreb(orderId, amountCents, payer, cellphone, description = 'Sonó · servicio') {
  if (!config.hasEfipay) throw new Error('EfiPay no configurado (EFIPAY_TOKEN)');
  const gen = await generateApiPayment(orderId, amountCents, description);
  const data = await checkoutPost('/payment/transaction-checkout/bre-b', {
    payment: { id: gen.payment_id, token: gen.token },
    customer_payer: { name: payer.name, email: payer.email },
    breb: { cellphone_number: String(cellphone || '').replace(/\D/g, '') },
  });
  return readCheckoutResult(data);
}

/**
 * Cobro en efectivo embebido. Genera un cupón para pagar en corresponsal.
 * `cash` = { network/association_code del corresponsal elegido } (ver available-cash).
 * El resultado final llega por webhook.
 */
export async function chargeCash(orderId, amountCents, payer, cash, description = 'Sonó · servicio') {
  if (!config.hasEfipay) throw new Error('EfiPay no configurado (EFIPAY_TOKEN)');
  const gen = await generateApiPayment(orderId, amountCents, description);
  const data = await checkoutPost('/payment/transaction-checkout/cash', {
    payment: { id: gen.payment_id, token: gen.token },
    customer_payer: { name: payer.name, email: payer.email },
    cash: cash || {},
  });
  return readCheckoutResult(data);
}

/** Recursos para los formularios del front (lista bancos PSE, tipos de id PSE, efectivos). */
export async function getResource(name) {
  if (!config.hasEfipay) throw new Error('EfiPay no configurado (EFIPAY_TOKEN)');
  const map = {
    'pse-banks': '/resources/checkout/pse-banks',
    'pse-id-types': '/resources/checkout/pse-identification-types',
    'cash': '/resources/checkout/available-cash',
    'methods': '/resources/available-payment-methods',
  };
  const path = map[name];
  if (!path) throw new Error(`recurso desconocido: ${name}`);
  const resp = await fetch(`${EFI_API}${path}`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`EfiPay ${path} HTTP ${resp.status}`);
  return resp.json();
}

/** Consulta el estado de una transacción/pago por su id. Devuelve el objeto o null. */
export async function fetchEfiTransaction(transactionId) {
  if (!config.hasEfipay) return null;
  try {
    const resp = await fetch(`${EFI_API}/payment/transaction/${encodeURIComponent(transactionId)}`, {
      headers: authHeaders(),
    });
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
  } catch {
    return null;
  }
}

// ───────────────────────── B) SUSCRIPCIÓN POR TARJETA ─────────────────────────

/**
 * Crea (o asegura) un plan recurrente en EfiPay. `intervalUnit` = 'month'|'year'.
 * Devuelve el plan creado. Se llama una vez al provisionar las tarifas, no por cliente.
 */
export async function createPlan({ name, description, priceCents, intervalCount = 1, intervalUnit = 'month', trialPeriod = 0, trialUnit = 'month' }) {
  if (!config.hasEfipay) throw new Error('EfiPay no configurado (EFIPAY_TOKEN)');
  const body = {
    name,
    description,
    price: Math.round(priceCents / 100),
    currency_type: 'COP',
    invoice_period: intervalCount,
    invoice_interval: intervalUnit,
  };
  if (trialPeriod > 0) {
    body.trial_period = trialPeriod;
    body.trial_interval = trialUnit;
  }
  return efiPost('/subscriptions/plan', body);
}

/** Crea un suscriptor (el cliente). Devuelve el objeto con su id. */
export async function createSubscriber({ name, email, identificationType = 'CC', idNumber, phone, office = config.EFIPAY_OFFICE }) {
  if (!config.hasEfipay) throw new Error('EfiPay no configurado (EFIPAY_TOKEN)');
  return efiPost('/subscriptions/subscriber', {
    name,
    email,
    identification_type: identificationType,
    id_number: idNumber,
    cellphone: phone,
    office,
  });
}

/**
 * Crea la suscripción recurrente: liga plan + suscriptor + tarjeta. EfiPay tokeniza
 * la tarjeta y cobra automático cada ciclo. Pasar `cardToken` (ya tokenizada) O
 * `cardInformation` { holder, number, datetime: 'yyyy-mm', cvv } — nunca ambos.
 */
export async function createSubscription({ planId, subscriberId, cardToken, cardInformation, description }) {
  if (!config.hasEfipay) throw new Error('EfiPay no configurado (EFIPAY_TOKEN)');
  if (!cardToken && !cardInformation) throw new Error('createSubscription: falta cardToken o cardInformation');
  const body = { plan_id: planId, subscriber_id: subscriberId };
  if (description) body.description = description;
  if (cardToken) body.card = cardToken;
  else body.card_information = cardInformation;
  return efiPost('/subscriptions/subscription', body);
}

// ───────────────────────── WEBHOOK ─────────────────────────

/**
 * Verifica que el webhook viene de EfiPay comparando el token compartido del panel
 * (Token Webhooks). EfiPay lo manda en header o body según el evento; aceptamos ambos.
 */
export function isValidEfiWebhook(req) {
  if (!config.EFIPAY_WEBHOOK_TOKEN) return true; // sin token configurado, no validamos
  const t =
    req.headers['x-efipay-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.body?.token ||
    req.query?.token;
  return t === config.EFIPAY_WEBHOOK_TOKEN;
}

/** Extrae { reference, status, transactionId } de la notificación del webhook. */
export function parseEfiWebhook(req) {
  const b = req.body || {};
  const tx = b.transaction || b.data?.transaction || b.data || b;
  const reference =
    (Array.isArray(tx?.references) ? tx.references[0] : null) ||
    tx?.reference ||
    tx?.external_reference ||
    null;
  return {
    reference,
    status: tx?.status || b.status || null,
    transactionId: tx?.transaction_id || tx?.id || null,
  };
}
