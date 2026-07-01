// Encola mensajes de WhatsApp para el agente de la PC del dueño. Espejo de
// activation-email.js pero sobre la cola wa_outbox. Su fallo NUNCA bloquea el flujo:
// el correo de activación sigue siendo la red de seguridad.

import { config } from './config.js';
import { logger } from './logger.js';
import { enqueueWa } from './storage.js';

/** Normaliza a formato WhatsApp COL (57 + celular). Política: siempre intentar. */
export function normalizePhoneCO(raw) {
  let d = String(raw || '').replace(/\D/g, ''); // solo dígitos
  if (!d) return '';
  if (d.length === 12 && d.startsWith('57')) return d;      // ya normalizado
  if (d.length === 10 && d.startsWith('3')) return '57' + d; // celular COL
  return d; // cualquier otra cosa: se limpia pero se intenta igual
}

function linkFor(order) {
  const base = (config.FRONTEND_BASE_URL || 'https://sono.lat').replace(/\/$/, '');
  return `${base}/activar-pro?order=${order.id}`;
}

// Variantes por kind. La elección es determinista por hash del order.id: distintos
// clientes reciben textos distintos (baja el patrón "mensaje idéntico masivo"), pero
// el MISMO cliente siempre ve el mismo texto (idempotencia visual en reintentos).
function pickVariant(orderId, variants) {
  let h = 0;
  for (let i = 0; i < orderId.length; i++) h = (h * 31 + orderId.charCodeAt(i)) >>> 0;
  return variants[h % variants.length];
}

export function buildWaBody(order, kind) {
  const link = linkFor(order);
  const nombre = order.business_name ? order.business_name.split(' ')[0] : '';
  const hola = nombre ? `Hola ${nombre}` : 'Hola';
  if (kind === 'activacion') {
    return pickVariant(order.id, [
      `${hola} 👋 Soy de Sonó. ¡Gracias por tu compra! Para que tu Sonó empiece a anunciar tus ventas falta un paso (2 min, desde el celular): ${link}`,
      `${hola}, gracias por tu compra en Sonó 🎉 Solo queda conectar tu Sonó con tu banco para que escuche cada pago. Entra aquí cuando puedas: ${link}`,
    ]);
  }
  if (kind === 'recordatorio_3h') {
    return pickVariant(order.id, [
      `${hola}, vi que tu Sonó quedó a medio conectar. En 2 minutos lo dejas listo para que anuncie tus ventas: ${link}`,
      `${hola} 🙂 Te recuerdo el último paso para activar tu Sonó (toma 2 min): ${link}`,
    ]);
  }
  // recordatorio_24h
  return pickVariant(order.id, [
    `${hola}, tu Sonó todavía está sin conectar. Cuando quieras lo activas aquí y empieza a anunciar tus pagos: ${link}`,
    `${hola} 👋 Aún puedes terminar de activar tu Sonó en 2 minutos: ${link}. Si necesitas ayuda, escríbeme por aquí.`,
  ]);
}

/** Normaliza el teléfono, arma el texto y encola. Idempotente por (order.id, kind). */
export function enqueueWhatsApp(order, kind) {
  if (!order) return false;
  const phone = normalizePhoneCO(order.phone);
  if (!phone) {
    logger.warn({ orderId: order.id }, 'wa: orden sin teléfono válido, no se encola WhatsApp');
    return false;
  }
  const body = buildWaBody(order, kind);
  const inserted = enqueueWa({ orderId: order.id, phone, kind, body });
  if (inserted) logger.info({ orderId: order.id, kind, phone }, 'wa: mensaje encolado');
  return inserted;
}
