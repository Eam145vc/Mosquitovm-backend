// Cobro programado de las cuotas 2 y 3 (plan "cuotas", $69.000 x3).
//
// La 1ª cuota se cobra en el checkout (http-server) y ahí se tokeniza la tarjeta.
// Las cuotas 2 y 3 las cobra ESTE job, con el token guardado, sin re-pedir la tarjeta:
//   - cada hora revisa órdenes con `installment_next_at` vencido (plan cuotas, no completo)
//   - cobra la cuota con chargeWithToken
//   - si aprueba: +1 a installments_paid; si quedan cuotas, programa la siguiente a +30d;
//     si era la última (3ª), marca installments_state='completado' y limpia el cobro.
//   - si falla: suma installment_fails y reintenta al día siguiente. Al 3er fallo
//     consecutivo, SUSPENDE el servicio (corte de anuncios por sub_status) y deja la
//     orden en 'suspendido' para resolución manual.
//
// Las cuotas pagadas con PSE/otros medios (sin token) caen en 'sin_token' y NO se cobran
// acá: requieren link manual (lo cuadramos aparte). El job las salta.

import { config } from './config.js';
import { logger } from './logger.js';
import {
  listOrders, updateOrder, getOrder, setSubStatus,
  createPaymentIntent, claimPooledAmount, getActiveIntentByOrder, countIntentsFor,
} from './storage.js';
import { chargeWithToken } from './efipay.js';
import { enqueueWhatsAppForce, orderSilenciada } from './wa-enqueue.js';

const DAY = 24 * 3600 * 1000;
const MAX_FAILS = 3; // al 3er fallo consecutivo se suspende el servicio

// ── Cobro por Bre-B (órdenes SIN tarjeta tokenizada: Bre-B/PSE/contraentrega) ──
// Pool de montos (idea del dueño): cada cobro activo reserva un monto único
// ($69.000 → $68.999 → … → $68.951) y el correo de Nequi identifica quién pagó.
export const CUOTA_POOL_SIZE = 50;               // hasta 50 cobros activos a la vez
export const CUOTA_INTENT_TTL_MS = 72 * 3600 * 1000; // el cliente paga cuando pueda (3 días)
export const CUOTA_MATCH_GRACE_MS = 45_000;      // misma gracia que el matcher del checkout
const MAX_RECORDATORIOS = 3;                     // 3 intents vencidos sin pago → gestión manual

/**
 * ¿A esta orden le toca cobrar una cuota por Bre-B, y cuál? Devuelve { n } o null.
 * Normalización clave: en órdenes pagadas/despachadas con installments_paid en 0,
 * la 1ª cuota SÍ se pagó (en el checkout o al recibir) — solo el flujo de tarjeta
 * la registraba. Acá se cuenta como pagada sin mutar la DB.
 */
export function installmentDue(order, now = Date.now()) {
  if (!order || order.plan !== 'cuotas') return null;
  if (order.card_token) return null; // con tarjeta va el cobro automático de arriba
  if (order.archived_at || ['cancelada', 'declined', 'created'].includes(order.status)) return null;
  if (order.installments_state === 'completado' || order.installments_state === 'suspendido') return null;
  const total = order.installments_total || 3;
  const paidEff = Math.max(1, order.installments_paid || 0);
  if (paidEff >= total) return null;
  if (now < order.created_at + 30 * DAY * paidEff) return null;
  return { n: paidEff + 1, paidEff, total };
}

// Las cuotas 2 y 3 son $69.000 PLANAS: el envío ($12.000) y el recargo de
// contraentrega ($5.000) van SOLO en la 1ª (el amount_cents del checkout).
// Cobrar amount_cents acá repetía el envío en cada cuota (bug detectado el
// 8-jul-2026 al mostrar el monto en La Libreta; ninguna cuota 2/3 se había
// cobrado aún). Exportada: La Libreta muestra este mismo monto.
export const CUOTA_2_3_CENTS = 6_900_000;
function cuotaCents() {
  return CUOTA_2_3_CENTS;
}

// payer + identificación a partir de los datos de envío que guardó la orden.
function payerFrom(order) {
  return {
    name: order.business_name || 'Cliente Sonó',
    email: order.mp_payer_email || order.customer_email || 'pagos@sono.lat',
    country: 'COL',
    state: order.city || 'Bogota',
    city: order.city || 'Bogota',
    address1: order.address || 'No informado',
    address2: order.address || 'No informado',
    zipCode: '110111',
  };
}

// Cobra UNA orden que tiene una cuota vencida. Devuelve true si avanzó (cobró o falló controlado).
async function chargeOneInstallment(order) {
  const orderId = order.id;
  const total = order.installments_total || 3;
  const paid = order.installments_paid || 0;
  const nextNum = paid + 1; // qué cuota toca (2 o 3)

  if (!order.card_token) {
    // sin token (PSE u otro medio, o tokenización fallida): no se cobra acá.
    return false;
  }

  try {
    const res = await chargeWithToken(
      orderId, cuotaCents(), order.card_token, payerFrom(order),
      { idType: 'CC', idNumber: '0000000000', phone: order.phone },
      `Sonó · cuota ${nextNum} de ${total}`,
    );

    if (res.approved) {
      const nowPaid = paid + 1;
      if (nowPaid >= total) {
        // última cuota: plan completado, ya no se cobra más.
        updateOrder(orderId, {
          installments_paid: nowPaid,
          installment_next_at: null,
          installment_fails: 0,
          installments_state: 'completado',
        });
        logger.info({ orderId, cuota: nextNum, total }, 'cuotas: última cuota cobrada, plan COMPLETADO');
      } else {
        // quedan cuotas: programar la siguiente a +30d.
        updateOrder(orderId, {
          installments_paid: nowPaid,
          installment_next_at: Date.now() + 30 * DAY,
          installment_fails: 0,
          installments_state: 'al_dia',
        });
        logger.info({ orderId, cuota: nextNum, total }, 'cuotas: cuota cobrada, siguiente programada (+30d)');
      }
      return true;
    }

    // EfiPay respondió pero no aprobó → tratar como fallo.
    return handleFail(order, `no aprobada (${res.status})`);
  } catch (e) {
    return handleFail(order, e.message);
  }
}

// Suma un fallo; reintenta al día siguiente. Al 3er fallo, suspende el servicio.
function handleFail(order, reason) {
  const orderId = order.id;
  const fails = (order.installment_fails || 0) + 1;
  const nextNum = (order.installments_paid || 0) + 1;

  if (fails >= MAX_FAILS) {
    // corte de servicio: suspende la cuenta (si ya está enlazada) → deja de anunciar.
    if (order.account_id) {
      setSubStatus(order.account_id, 'suspendida');
    }
    updateOrder(orderId, {
      installment_fails: fails,
      installment_next_at: null, // deja de reintentar solo; requiere acción manual
      installments_state: 'suspendido',
    });
    logger.error({ orderId, cuota: nextNum, fails, reason }, 'cuotas: 3er fallo, SERVICIO SUSPENDIDO');
  } else {
    updateOrder(orderId, {
      installment_fails: fails,
      installment_next_at: Date.now() + 1 * DAY, // reintenta mañana
      installments_state: 'en_mora',
    });
    logger.warn({ orderId, cuota: nextNum, fails, reason }, 'cuotas: cobro falló, reintenta en 24h');
  }
  return true;
}

// Una pasada: cobra todas las cuotas vencidas.
async function runDueInstallments() {
  if (!config.hasEfipay) return;
  const now = Date.now();
  let due;
  try {
    due = listOrders().filter((o) =>
      o.plan === 'cuotas' &&
      o.card_token &&
      o.installment_next_at &&
      o.installment_next_at <= now &&
      (o.installments_paid || 0) < (o.installments_total || 3) &&
      o.installments_state !== 'completado' &&
      o.installments_state !== 'suspendido',
    );
  } catch (e) {
    logger.error({ err: e.message }, 'cuotas: error listando órdenes vencidas');
    return;
  }
  if (!due.length) return;
  logger.info({ count: due.length }, 'cuotas: procesando cobros vencidos');
  for (const order of due) {
    // releemos la orden por si cambió, y cobramos de a una (sin paralelizar el cobro).
    const fresh = getOrder(order.id);
    if (fresh) await chargeOneInstallment(fresh);
  }
}

// Una pasada de RECORDATORIOS Bre-B: para cada orden con cuota vencida y sin
// intent activo, reserva un monto del pool y (re)manda la plantilla sono_cuota.
// Cada intent dura 72 h; si vence sin pago, la siguiente pasada crea otro y
// re-manda (≈1 recordatorio cada 3 días, máx 3 → luego 'en_mora' manual).
// Apagado por defecto: se enciende con CUOTAS_WA_ENABLED=1 en el .env, para que
// el primer envío masivo sea una decisión consciente del dueño.
export function runBrebInstallmentReminders({ dryRun = false } = {}) {
  if (!dryRun && process.env.CUOTAS_WA_ENABLED !== '1') return [];
  const now = Date.now();
  const acciones = [];
  let due;
  try {
    due = listOrders().filter((o) => !orderSilenciada(o) && installmentDue(o, now));
  } catch (e) {
    logger.error({ err: e.message }, 'cuotas breb: error listando vencidas');
    return [];
  }
  for (const order of due) {
    const d = installmentDue(order, now);
    if (!d) continue;
    if (getActiveIntentByOrder(order.id, 'cuota')) continue; // cobro en curso, no repetir
    const intentos = countIntentsFor(order.id, 'cuota', d.n);
    if (intentos >= MAX_RECORDATORIOS) {
      if (order.installments_state !== 'en_mora') {
        if (!dryRun) updateOrder(order.id, { installments_state: 'en_mora' });
        acciones.push({ orderId: order.id, business: order.business_name, cuota: d.n, accion: 'en_mora' });
        logger.warn({ orderId: order.id, cuota: d.n, intentos }, 'cuotas breb: sin pago tras recordatorios, EN MORA (gestión manual)');
      }
      continue;
    }
    const amount = claimPooledAmount(Math.round(CUOTA_2_3_CENTS / 100), CUOTA_POOL_SIZE, { graceMs: CUOTA_MATCH_GRACE_MS });
    if (amount === null) {
      logger.warn({ orderId: order.id }, 'cuotas breb: pool de montos lleno, se difiere a la próxima pasada');
      break; // el pool es global: si está lleno, no insistir con las demás
    }
    acciones.push({ orderId: order.id, business: order.business_name, cuota: d.n, amount, accion: intentos === 0 ? 'recordatorio' : `reintento_${intentos + 1}` });
    if (dryRun) continue;
    createPaymentIntent({ orderId: order.id, amount, ttlMs: CUOTA_INTENT_TTL_MS, kind: 'cuota', installmentN: d.n });
    enqueueWhatsAppForce(order, d.n === 3 ? 'cuota_3' : 'cuota_2');
    logger.info({ orderId: order.id, cuota: d.n, amount, intento: intentos + 1 }, 'cuotas breb: recordatorio encolado');
  }
  return acciones;
}

/** Arranca el job: corre al inicio y cada hora. */
export function startInstallmentsScheduler() {
  const pass = async () => {
    await runDueInstallments();
    runBrebInstallmentReminders();
  };
  pass().catch((e) => logger.error({ err: e.message }, 'cuotas: primera pasada falló'));
  setInterval(() => {
    pass().catch((e) => logger.error({ err: e.message }, 'cuotas: pasada periódica falló'));
  }, 60 * 60 * 1000); // cada hora
  logger.info('cuotas: scheduler de cobro de cuotas iniciado (cada 1h)');
}
