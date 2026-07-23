// Push "caja registradora": cada venta confirmada (orden que pasa a pagada)
// manda una notificación Web Push a la PWA de soporte del dueño.
// El cha-ching lo reproduce la PWA si está abierta; con la app cerrada Web Push
// no permite sonido custom → suena el tono default del sistema (limitación iOS/Android).

import { notifyAdmins } from './support/webpush.js';
import { sendTelegram } from './telegram.js';
import { logger } from './logger.js';

// Dedupe en memoria: webhook + polling + conciliación pueden confirmar la misma
// orden casi a la vez; isPaid() protege casi siempre, esto cubre la carrera.
const notified = new Set();

const fmtCop = (cents) => '$' + Math.round((cents || 0) / 100).toLocaleString('es-CO');

export function notifySale(order, via) {
  if (!order || notified.has(order.id)) return;
  notified.add(order.id);
  const body = [fmtCop(order.amount_cents), order.business_name || 'Sin nombre', via]
    .filter(Boolean).join(' · ');
  notifyAdmins({
    title: '💰 ¡Venta!',
    body,
    tag: `sono-venta-${order.id}`, // tag único: dos ventas = dos notificaciones
    sound: 'cash',
    url: '/soporte-app/',
  }).then((r) => logger.info({ orderId: order.id, via, sent: r.sent }, 'push de venta enviado'))
    .catch((e) => logger.warn({ orderId: order.id, err: e.message }, 'push de venta falló'));
  // Telegram en paralelo: es el canal que SÍ suena con sonido custom (cha-ching
  // del chat) aunque el teléfono tenga todo cerrado.
  sendTelegram(`💰 ¡Venta! ${body}`)
    .catch((e) => logger.warn({ orderId: order.id, err: e.message }, 'telegram de venta falló'));
}
