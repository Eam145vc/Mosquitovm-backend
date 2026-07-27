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
} from './storage.js';
import { chargeWithToken } from './efipay.js';
import { enqueueWhatsAppForce, orderSilenciada } from './wa-enqueue.js';

const DAY = 24 * 3600 * 1000;
const MAX_FAILS = 3; // al 3er fallo consecutivo se suspende el servicio

// ── Cobro por Bre-B (órdenes SIN tarjeta tokenizada: Bre-B/PSE/contraentrega) ──
// Pool de montos (idea del dueño): cada cobro ACTIVO reserva un monto único
// ($69.000 → $68.999 → …) y el correo de Nequi identifica quién pagó. El monto
// se reserva SOLO cuando el cliente toca "Voy a pagar" en /cuota — el
// recordatorio de WhatsApp no abre ninguna ventana ni reserva nada, solo avisa.
// Ventana CORTA (igual espíritu que el checkout: se abre al pedirla, se cierra
// si no se usa) para que el pool rote rápido y libere el monto para el siguiente.
export const CUOTA_POOL_SIZE = 20;               // hasta 20 cobros "en pantalla" a la vez
export const CUOTA_INTENT_TTL_MS = 5 * 60 * 1000; // 5 min desde que toca "Voy a pagar"
export const CUOTA_MATCH_GRACE_MS = 45_000;      // misma gracia que el matcher del checkout
const MAX_RECORDATORIOS = 3;                     // 3 recordatorios sin pago → gestión manual
const REMINDER_EVERY_MS = 3 * DAY;               // cadencia entre recordatorios
// Gracia desde que la cuota vence hasta la fecha límite que se le anuncia al
// cliente. FIJA a propósito: si el plazo se recalculara en cada recordatorio, la
// fecha se correría sola y el cliente aprendería que el plazo es elástico.
export const CUOTA_GRACIA_MS = 7 * DAY;

/**
 * Fecha límite que se le comunica al cliente ("tienes plazo hasta el 6 de agosto").
 * Anclada al VENCIMIENTO real de la cuota (compra + 30 días por cuota ya pagada),
 * no al recordatorio: así los 3 recordatorios repiten la MISMA fecha y el cierre
 * es coherente con lo anunciado.
 */
export function fechaLimiteCuota(order, now = Date.now()) {
  const due = installmentDue(order, now);
  const paidEff = due ? due.paidEff : Math.max(1, order?.installments_paid || 0);
  const vencimiento = (order?.created_at || now) + 30 * DAY * paidEff;
  return vencimiento + CUOTA_GRACIA_MS;
}

/** ¿Ya se pasó la fecha límite anunciada? (base del corte de servicio). */
export function cuotaVencidaConPlazo(order, now = Date.now()) {
  return Boolean(installmentDue(order, now)) && now > fechaLimiteCuota(order, now);
}

/** "30 de julio" en horario de Bogotá (formato del mensaje y de la página). */
export function fechaLimiteTexto(ms) {
  return new Intl.DateTimeFormat('es-CO', {
    day: 'numeric', month: 'long', timeZone: 'America/Bogota',
  }).format(new Date(ms));
}

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

// Una pasada de RECORDATORIOS Bre-B: para cada orden con cuota vencida, manda
// (o remanda) la plantilla sono_cuota SIN reservar monto ni crear intent — es
// solo un aviso ("debes la cuota N"). El monto se reserva únicamente cuando el
// cliente toca "Voy a pagar" en /cuota (ver POST /cuota/:order/pagar en
// http-server.js). Cadencia por installment_reminder_at/count (no por intents,
// que ahora son efímeros): ~1 recordatorio cada 3 días, máx 3 → 'en_mora' manual.
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
    const count = order.installment_reminder_count || 0;
    if (count >= MAX_RECORDATORIOS) {
      if (order.installments_state !== 'en_mora') {
        if (!dryRun) updateOrder(order.id, { installments_state: 'en_mora' });
        acciones.push({ orderId: order.id, business: order.business_name, cuota: d.n, accion: 'en_mora' });
        logger.warn({ orderId: order.id, cuota: d.n, count }, 'cuotas breb: sin pago tras recordatorios, EN MORA (gestión manual)');
      }
      continue;
    }
    const lastAt = order.installment_reminder_at || 0;
    if (now - lastAt < REMINDER_EVERY_MS) continue; // ya se le avisó hace poco
    acciones.push({ orderId: order.id, business: order.business_name, cuota: d.n, accion: count === 0 ? 'recordatorio' : `reintento_${count + 1}` });
    if (dryRun) continue;
    updateOrder(order.id, { installment_reminder_at: now, installment_reminder_count: count + 1 });
    enqueueWhatsAppForce(order, d.n === 3 ? 'cuota_3' : 'cuota_2');
    logger.info({ orderId: order.id, cuota: d.n, intento: count + 1 }, 'cuotas breb: recordatorio encolado (sin monto reservado)');
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
