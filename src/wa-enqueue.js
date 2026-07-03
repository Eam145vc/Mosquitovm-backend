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

const moneyCo = (cents) => `$${Math.round(cents / 100).toLocaleString('es-CO')}`;

// Recargo de pago contraentrega (espejo de RECARGO_CONTRAENTREGA_CENTS en http-server.js).
// En órdenes COD el amount_cents YA lo incluye, así que acá solo se discrimina.
const RECARGO_COD_CENTS = 500_000;

// Bloque "cuánto pagas al recibir" para el WhatsApp de envío de órdenes contraentrega.
// wompi_txn_id presente = ya se cobró online (aunque la orden sea delivery contraentrega),
// en ese caso no se pide plata. Devuelve '' si no aplica.
function codBlockFor(order) {
  const esCodSinPagar = order.delivery === 'contraentrega' && !order.wompi_txn_id;
  if (!esCodSinPagar || !order.amount_cents) return '';
  const producto = order.amount_cents - RECARGO_COD_CENTS;
  // En cuotas lo que se recauda al recibir es la 1ª cuota + el envío (no el producto entero).
  const etiqueta = order.plan === 'cuotas' ? '1ª cuota + envío' : 'Producto';
  const desglose = producto > 0
    ? `\n• ${etiqueta}: ${moneyCo(producto)}\n• Recargo contraentrega: ${moneyCo(RECARGO_COD_CENTS)}`
    : '';
  return `\n\n💵 Pagas al recibir: ${moneyCo(order.amount_cents)} (en efectivo al mensajero)${desglose}`;
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
  // 'guia_creada' (webhook created): la guía quedó registrada. Es EL mensaje completo:
  // número de guía + rastreo + datos de entrega para que el cliente los revise ANTES
  // del despacho (corregir a tiempo evita devoluciones) + COD + link del correo.
  if (kind === 'guia_creada') {
    const sh = getShipmentByOrder(order.id);
    const guia = sh?.tracking || '';
    const carrier = sh?.carrier || 'la transportadora';
    const cod = codBlockFor(order);
    const conectar = `\n\nCuando te llegue, conecta el correo donde te avisan tus pagos (2 min) y tu Sonó empieza a anunciar cada venta: ${emailLinkFor(order)}`;
    const datos = `\n\nRevisa que tus datos de entrega estén correctos:\n👤 ${order.business_name || 'Sin nombre'}\n📍 ${order.address || 'Sin dirección'}${order.city ? `, ${order.city}` : ''}\nSi algo está mal, escríbeme por aquí YA para corregirlo antes del despacho.`;
    const rastreo = sh?.tracking_url
      ? `\n\nSíguelo aquí: ${sh.tracking_url}`
      : (guia ? `\n\nRastréalo con ese número en la web de ${carrier}.` : '');
    return pickVariant(order.id, [
      `${hola} 📦 ¡Tu Sonó ya tiene guía de envío! Guía ${guia} por ${carrier}.${datos}${cod}${rastreo}${conectar}`,
      `${hola}, ¡listo! Ya se generó la guía de tu Sonó: ${guia} (${carrier}).${datos}${cod}${rastreo}${conectar}`,
    ]);
  }
  // 'envio' (webhook picked_up/in_transit): la transportadora ya tiene el paquete.
  // Versión LIGHT a propósito: la guía/rastreo/COD ya fueron en 'guia_creada'.
  if (kind === 'envio') {
    return pickVariant(order.id, [
      `${hola} 🚚 ¡Tu Sonó ya va en camino! La transportadora recogió el paquete. Te aviso cuando salga a entrega.`,
      `${hola} 📦 Tu Sonó ya está en manos de la transportadora, ¡va en camino! Te aviso cuando esté por llegar.`,
    ]);
  }
  // ── Avisos de tracking (webhook de Skydropx) ──────────────────────────────
  // 'reparto' (last_mile): el paquete sale a entrega HOY. En COD es el aviso clave:
  // que el cliente esté en el local y con el efectivo (las devoluciones las paga Sonó).
  if (kind === 'reparto') {
    const sh = getShipmentByOrder(order.id);
    const cod = codBlockFor(order);
    const rastreo = sh?.tracking_url ? `\n\nSíguelo aquí: ${sh.tracking_url}` : '';
    return pickVariant(order.id, [
      `${hola} 📦 ¡Tu Sonó está en reparto y te llega HOY! Mantente atento al mensajero.${cod}${rastreo}`,
      `${hola} 🚚 Tu Sonó salió a entrega hoy. Está pendiente del mensajero, por favor.${cod}${rastreo}`,
    ]);
  }
  // 'intento_entrega' (delivery_attempt): la transportadora no pudo entregar. Avisar YA:
  // tras varios intentos fallidos el paquete se devuelve (y el flete de retorno lo paga Sonó).
  if (kind === 'intento_entrega') {
    const sh = getShipmentByOrder(order.id);
    const cod = codBlockFor(order);
    const rastreo = sh?.tracking_url ? `\n\nRastreo: ${sh.tracking_url}` : '';
    return pickVariant(order.id, [
      `${hola}, la transportadora intentó entregar tu Sonó y no fue posible 😕 Suelen reintentar el próximo día hábil: mantente atento al mensajero. Si hay algún problema con la dirección, escríbeme por aquí (tras varios intentos fallidos el paquete se devuelve).${cod}${rastreo}`,
      `${hola} ⚠️ El mensajero intentó entregar tu Sonó y no te encontró. Normalmente reintentan pronto, mantente pendiente. ¿Algún problema con la dirección? Escríbeme por aquí para que el paquete no se devuelva.${cod}${rastreo}`,
    ]);
  }
  // 'entregado' (delivered): confirmación + el paso diferido de conectar el correo.
  if (kind === 'entregado') {
    return pickVariant(order.id, [
      `${hola} 🎉 ¡Tu Sonó fue entregado! Último paso: conecta el correo donde te avisan tus pagos (2 min) y empieza a anunciar cada venta: ${emailLinkFor(order)}`,
      `${hola}, ¡ya recibiste tu Sonó! 🎉 Para activarlo, conecta el correo donde te llegan los avisos de pago (2 min): ${emailLinkFor(order)}. Cualquier duda, escríbeme por aquí.`,
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
  // Orden archivada (soft-delete): al cliente no se le manda NINGÚN mensaje automático.
  if (order.archived_at) {
    logger.info({ orderId: order.id, kind }, 'wa: orden archivada, no se encola');
    return false;
  }
  // Los mensajes de onboarding piden subir el QR: si la orden YA lo tiene, son ruido
  // (típico: compra nocturna con PC apagada, el cliente sube el QR de una y el pago se
  // confirma después). El envío manual del admin (enqueueWhatsAppForce) NO pasa por acá.
  if (PHONE_DEDUPE_KINDS.has(kind) && order.qr_path) {
    logger.info({ orderId: order.id, kind }, 'wa: la orden ya tiene QR, onboarding no se encola');
    return false;
  }
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

/** Encola WhatsApp de envío ("ya va en camino", light) si la orden tiene teléfono y tracking. */
export function enqueueEnvioIfReady(order) {
  if (!order) return false;
  const phone = normalizePhoneCO(order.phone);
  if (!phone) { logger.warn({ orderId: order.id }, 'wa: envío sin teléfono'); return false; }
  const sh = getShipmentByOrder(order.id);
  if (!sh?.tracking) return false; // tracking async: lo tomará el job
  return enqueueWhatsApp(order, 'envio');
}

/** Encola el WhatsApp de guía creada (guía + revisar datos + COD + correo) si la
 *  orden tiene teléfono y el envío ya tiene número de guía (el texto lo muestra). */
export function enqueueGuiaCreadaIfReady(order) {
  if (!order) return false;
  const phone = normalizePhoneCO(order.phone);
  if (!phone) { logger.warn({ orderId: order.id }, 'wa: guía creada sin teléfono'); return false; }
  const sh = getShipmentByOrder(order.id);
  if (!sh?.tracking) return false; // tracking async: lo tomará el job o el próximo evento
  return enqueueWhatsApp(order, 'guia_creada');
}
