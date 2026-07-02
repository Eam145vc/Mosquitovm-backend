// Encola mensajes de WhatsApp para el agente de la PC del dueño. Espejo de
// activation-email.js pero sobre la cola wa_outbox. Su fallo NUNCA bloquea el flujo:
// el correo de activación sigue siendo la red de seguridad.

import { config } from './config.js';
import { logger } from './logger.js';
import { enqueueWa, enqueueWaForce, getShipmentByOrder, hasRecentWa } from './storage.js';

// Mensajes de onboarding: son genéricos ("sube tu QR"), así que si el MISMO teléfono ya
// recibió ese tipo hace poco por OTRA orden (cliente que reintentó el checkout y quedó
// con órdenes duplicadas), no se repite. 'envio' NO dedupea: cada orden lleva su guía.
const PHONE_DEDUPE_KINDS = new Set(['activacion', 'recordatorio_3h', 'recordatorio_24h']);
const PHONE_DEDUPE_WINDOW_MS = 48 * 3600 * 1000;

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

// Link para conectar el correo (paso diferido: se hace cuando el cliente RECIBE el
// altavoz, no en el onboarding — pedir el correo antes de entregar generaba desconfianza).
function emailLinkFor(order) {
  return `${linkFor(order)}&correo=1`;
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
      `${hola} 👋 Soy de Sonó. ¡Gracias por tu compra! Para enviarte tu Sonó solo falta que subas tu QR de Bre-B (2 min, desde el celular): ${link}`,
      `${hola}, gracias por tu compra en Sonó 🎉 Solo nos falta tu QR de Bre-B: lo imprimimos y te lo enviamos junto a tu altavoz. Súbelo aquí cuando puedas: ${link}`,
    ]);
  }
  if (kind === 'recordatorio_3h') {
    return pickVariant(order.id, [
      `${hola}, vi que falta subir tu QR de Bre-B. Sin él no podemos despachar tu Sonó (toma 2 min): ${link}`,
      `${hola} 🙂 Te recuerdo subir tu QR de Bre-B para poder enviarte tu Sonó (2 min): ${link}`,
    ]);
  }
  if (kind === 'envio') {
    const sh = getShipmentByOrder(order.id);
    const guia = sh?.tracking || '';
    const carrier = sh?.carrier || 'la transportadora';
    // Al despachar se entrega también el link para conectar el correo cuando le llegue
    // el altavoz (el onboarding solo pidió el QR; este es el paso que quedó diferido).
    const conectar = `\n\nCuando te llegue, conecta el correo donde te avisan tus pagos (2 min) y tu Sonó empieza a anunciar cada venta: ${emailLinkFor(order)}`;
    if (sh?.tracking_url) {
      return pickVariant(order.id, [
        `${hola}, tu Sonó ya va en camino 📦 Guía: ${guia} (${carrier}). Rástrealo aquí: ${sh.tracking_url}${conectar}`,
        `${hola} 🚚 Tu Sonó fue despachado. Guía ${guia} por ${carrier}. Sigue tu envío: ${sh.tracking_url}${conectar}`,
      ]);
    }
    if (guia) {
      return pickVariant(order.id, [
        `${hola}, tu Sonó ya va en camino 📦 Guía: ${guia} por ${carrier}. Rastréalo con ese número en la web de ${carrier}.${conectar}`,
        `${hola} 🚚 Tu Sonó fue despachado. Guía ${guia} (${carrier}). Rastrea con ese número en ${carrier}.${conectar}`,
      ]);
    }
    return pickVariant(order.id, [
      `${hola}, tu Sonó ya fue despachado 📦 Pronto te llega.${conectar}`,
      `${hola} 🚚 Tu Sonó va en camino, pronto lo recibes.${conectar}`,
    ]);
  }
  // recordatorio_24h
  return pickVariant(order.id, [
    `${hola}, tu Sonó sigue esperando tu QR de Bre-B para poder despacharse. Súbelo aquí y lo enviamos: ${link}`,
    `${hola} 👋 Aún falta subir tu QR de Bre-B para enviarte tu Sonó (2 min): ${link}. Si necesitas ayuda, escríbeme por aquí.`,
  ]);
}

/** Normaliza el teléfono, arma el texto y encola. Idempotente por (order.id, kind)
 *  y, en los kinds de onboarding, también por (teléfono, kind) en ventana de 48h. */
export function enqueueWhatsApp(order, kind) {
  if (!order) return false;
  const phone = normalizePhoneCO(order.phone);
  if (!phone) {
    logger.warn({ orderId: order.id }, 'wa: orden sin teléfono válido, no se encola WhatsApp');
    return false;
  }
  if (
    PHONE_DEDUPE_KINDS.has(kind) &&
    hasRecentWa({ phone, kind, excludeOrderId: order.id, sinceMs: Date.now() - PHONE_DEDUPE_WINDOW_MS })
  ) {
    logger.info({ orderId: order.id, kind, phone }, 'wa: mismo mensaje ya enviado a este teléfono por otra orden, no se duplica');
    return false;
  }
  const body = buildWaBody(order, kind);
  const inserted = enqueueWa({ orderId: order.id, phone, kind, body });
  if (inserted) logger.info({ orderId: order.id, kind, phone }, 'wa: mensaje encolado');
  return inserted;
}

/** Envío MANUAL desde el admin: igual que enqueueWhatsApp pero FUERZA el reenvío
 *  aunque ya exista una fila sent/failed/canceled/queued para ese (order, kind). */
export function enqueueWhatsAppForce(order, kind) {
  if (!order) return false;
  const phone = normalizePhoneCO(order.phone);
  if (!phone) {
    logger.warn({ orderId: order.id }, 'wa: orden sin teléfono válido, no se encola WhatsApp (force)');
    return false;
  }
  const body = buildWaBody(order, kind);
  const ok = enqueueWaForce({ orderId: order.id, phone, kind, body });
  if (ok) logger.info({ orderId: order.id, kind, phone }, 'wa: mensaje reencolado (force, manual admin)');
  return ok;
}

/** Encola WhatsApp de envío si la orden tiene teléfono y tracking. */
export function enqueueEnvioIfReady(order) {
  if (!order) return false;
  const phone = normalizePhoneCO(order.phone);
  if (!phone) { logger.warn({ orderId: order.id }, 'wa: envío sin teléfono'); return false; }
  const sh = getShipmentByOrder(order.id);
  if (!sh?.tracking) return false; // tracking async: lo tomará el job
  return enqueueWhatsApp(order, 'envio');
}
