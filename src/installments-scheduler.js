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
import { listOrders, updateOrder, getOrder, setSubStatus } from './storage.js';
import { chargeWithToken } from './efipay.js';

const DAY = 24 * 3600 * 1000;
const MAX_FAILS = 3; // al 3er fallo consecutivo se suspende el servicio

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

/** Arranca el job: corre al inicio y cada hora. */
export function startInstallmentsScheduler() {
  runDueInstallments().catch((e) => logger.error({ err: e.message }, 'cuotas: primera pasada falló'));
  setInterval(() => {
    runDueInstallments().catch((e) => logger.error({ err: e.message }, 'cuotas: pasada periódica falló'));
  }, 60 * 60 * 1000); // cada hora
  logger.info('cuotas: scheduler de cobro de cuotas iniciado (cada 1h)');
}
