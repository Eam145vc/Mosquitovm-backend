// Job de recordatorios de onboarding por WhatsApp. Cada corrida busca órdenes
// CONFIRMADAS (pago aprobado o COD creada) que NO terminaron el onboarding y encola
// recordatorio_3h / recordatorio_24h según su antigüedad. La idempotencia por
// (order_id, kind) en wa_outbox evita duplicados aunque el job corra muchas veces.

import { logger } from './logger.js';

const H = 3600 * 1000;

/**
 * Función pura: dada la lista de órdenes decide qué recordatorios tocan AHORA.
 * @param orders lista de órdenes
 * @param now epoch ms
 * @param stepOf (order) => number  paso del wizard (3 = completo)
 * @param confirmedAt (order) => epoch ms  momento en que se confirmó/creó
 * @returns Array<{order, kind}>
 */
export function dueReminders(orders, now, stepOf, confirmedAt) {
  const out = [];
  for (const o of orders) {
    if (o.status === 'created') continue;        // aún sin confirmar
    if (stepOf(o) >= 3) continue;                // onboarding ya completo
    const started = confirmedAt(o);
    if (!started) continue;
    const age = now - started;
    if (age >= 3 * H) out.push({ order: o, kind: 'recordatorio_3h' });
    if (age >= 24 * H) out.push({ order: o, kind: 'recordatorio_24h' });
  }
  return out;
}

/** Corre el job: calcula pendientes y los encola (dedupe lo hace wa_outbox). */
export function runWaReminderJob({ listOrders, stepOf, enqueue, confirmedAt, now }) {
  try {
    const orders = listOrders();
    const due = dueReminders(orders, now, stepOf, confirmedAt);
    let n = 0;
    for (const { order, kind } of due) {
      if (enqueue(order, kind)) n += 1;
    }
    if (n) logger.info({ encolados: n }, 'wa: recordatorios encolados');
  } catch (e) {
    logger.error({ err: e.message }, 'wa: reminder job error');
  }
}
