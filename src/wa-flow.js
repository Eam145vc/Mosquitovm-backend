// WhatsApp Flow del cobro de cuotas: la ventana de pago vive DENTRO de WhatsApp
// (el cliente nunca sale del chat). Dos pantallas:
//   AVISO → "Cuota 2 de 3: $69.000" + botón "Voy a pagar"
//   PAGO  → monto ÚNICO del pool + QR de Bre-B + llave (se abre al tocar el botón)
//
// El monto del pool se reserva SOLO al tocar "Voy a pagar" (data_exchange), igual
// que en la página web: la ventana es corta y el slot rota rápido.
//
// CIFRADO (exigido por Meta para Flows con endpoint): cada request trae una llave
// AES-128 efímera envuelta con nuestra RSA pública (RSA-OAEP SHA-256) y el payload
// cifrado con AES-128-GCM. La respuesta va cifrada con la MISMA llave AES pero con
// el IV invertido bit a bit (~iv), en base64 y como texto plano.
// Docs: developers.facebook.com/docs/whatsapp/flows/reference/flowsencryption

import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { getOrder, createPaymentIntent, claimPooledAmount, getActiveIntentByOrder, getPoolQr } from './storage.js';
import {
  CUOTA_2_3_CENTS, CUOTA_POOL_SIZE, CUOTA_INTENT_TTL_MS, CUOTA_MATCH_GRACE_MS, installmentDue,
} from './installments-scheduler.js';

const TAG_LENGTH = 16;
const moneyCo = (pesos) => `$${Math.round(pesos).toLocaleString('es-CO')}`;

// ── QR como PNG base64 (el componente Image del Flow recibe base64 pelado) ──
// zxing-wasm ya está en el proyecto (se usa para LEER los QR de los clientes);
// su submódulo writer genera el PNG sin sumar dependencias.
// Cache por monto: con QRs de valor fijo (pool_qrs) cada monto tiene su payload;
// sin QR cargado para el monto, cae al estático de Sonó (y el cliente digita).
const qrCache = new Map(); // amount → base64
async function qrBase64(amount) {
  if (qrCache.has(amount)) return qrCache.get(amount);
  const emvco = getPoolQr(amount) || config.SONO_BREB_EMVCO;
  if (!emvco) return '';
  const { writeBarcode } = await import('zxing-wasm/writer');
  const res = await writeBarcode(emvco, {
    format: 'QRCode', scale: 8, withQuietZones: true, ecLevel: 'M',
  });
  if (res.error || !res.image) {
    logger.error({ err: res.error, amount }, 'wa-flow: no se pudo generar el QR');
    return '';
  }
  const b64 = Buffer.from(await res.image.arrayBuffer()).toString('base64');
  qrCache.set(amount, b64);
  return b64;
}

// ── Cifrado ───────────────────────────────────────────────────────────────────

/** Descifra el request de Meta. Devuelve { body, aesKey, iv } o lanza. */
export function decryptFlowRequest({ encrypted_flow_data, encrypted_aes_key, initial_vector }) {
  const privateKey = crypto.createPrivateKey({
    key: config.WA_FLOW_PRIVATE_KEY,
    passphrase: config.WA_FLOW_PASSPHRASE || undefined,
  });
  const aesKey = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encrypted_aes_key, 'base64'),
  );
  const iv = Buffer.from(initial_vector, 'base64');
  const payload = Buffer.from(encrypted_flow_data, 'base64');
  const body = payload.subarray(0, -TAG_LENGTH);
  const tag = payload.subarray(-TAG_LENGTH);
  const decipher = crypto.createDecipheriv(`aes-${aesKey.length * 8}-gcm`, aesKey, iv);
  decipher.setAuthTag(tag);
  const clear = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf-8');
  return { body: JSON.parse(clear), aesKey, iv };
}

/** Cifra la respuesta con la misma AES y el IV invertido (exigencia de Meta). */
export function encryptFlowResponse(response, aesKey, iv) {
  const flipped = Buffer.from(iv.map((b) => ~b));
  const cipher = crypto.createCipheriv(`aes-${aesKey.length * 8}-gcm`, aesKey, flipped);
  return Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf-8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}

// ── Pantallas ─────────────────────────────────────────────────────────────────

/** El flow_token que mandamos al abrir el Flow es `cuota_<orderId>`. */
function orderIdFromToken(flowToken) {
  const s = String(flowToken || '');
  return s.startsWith('cuota_') ? s.slice(6) : '';
}

function pantallaAviso(order, due) {
  return {
    screen: 'AVISO',
    data: {
      cuota: String(due.n),
      total: String(order.installments_total || 3),
      monto: moneyCo(CUOTA_2_3_CENTS / 100),
    },
  };
}

async function pantallaPago(order, due) {
  // Reserva el monto único del pool (o reusa el vigente si el cliente reabrió el Flow).
  let intent = getActiveIntentByOrder(order.id, 'cuota');
  if (!intent) {
    const amount = claimPooledAmount(Math.round(CUOTA_2_3_CENTS / 100), CUOTA_POOL_SIZE, { graceMs: CUOTA_MATCH_GRACE_MS });
    if (amount === null) {
      // Pool lleno: no dejamos al cliente sin salida, se queda en el aviso con nota.
      logger.warn({ orderId: order.id }, 'wa-flow: pool de montos lleno');
      return {
        screen: 'AVISO',
        data: {
          cuota: String(due.n),
          total: String(order.installments_total || 3),
          monto: moneyCo(CUOTA_2_3_CENTS / 100) + ' · muchas personas pagando ahora, intenta en un minuto',
        },
      };
    }
    intent = createPaymentIntent({
      orderId: order.id, amount, ttlMs: CUOTA_INTENT_TTL_MS, kind: 'cuota', installmentN: due.n,
    });
    logger.info({ orderId: order.id, intentId: intent.id, amount, cuota: due.n },
      'cuota: ventana de pago abierta desde el Flow de WhatsApp');
  }
  const conValor = Boolean(getPoolQr(intent.amount));
  const instruccion = conValor
    ? `Toma un pantallazo del QR y cárgalo desde la galería en el lector de tu banco: ya trae el valor exacto (${moneyCo(intent.amount)}), solo confirma. Tienes 2 minutos y medio; con ese valor tu cuota queda registrada sola.`
    : `Toma un pantallazo del QR y cárgalo desde la galería en el lector de tu banco, o paga a la llave ${config.SONO_BREB_KEY || ''}. Envía exactamente ${moneyCo(intent.amount)} en los próximos 2 minutos y medio: con ese valor tu cuota queda registrada sola.`;
  return {
    screen: 'PAGO',
    data: {
      monto: moneyCo(intent.amount),
      qr: await qrBase64(intent.amount),
      llave: config.SONO_BREB_KEY || '',
      instruccion,
    },
  };
}

function pantallaSinDeuda() {
  return {
    screen: 'AVISO',
    data: { cuota: '-', total: '-', monto: 'No tienes cuotas pendientes 🎉' },
  };
}

/**
 * Resuelve un request YA descifrado del Flow. Devuelve el objeto de respuesta
 * (sin cifrar). Contrato de Meta: `ping` para health check, `INIT` al abrir,
 * `data_exchange` en cada botón, `BACK` al volver.
 */
export async function handleFlowAction(body) {
  const { action, flow_token: flowToken, screen } = body || {};
  if (action === 'ping') return { data: { status: 'active' } };
  // Meta avisa errores del cliente; se acusa recibo y ya.
  if (body?.data?.error) {
    logger.warn({ err: body.data.error }, 'wa-flow: error reportado por el cliente');
    return { data: { acknowledged: true } };
  }

  const orderId = orderIdFromToken(flowToken);
  const order = orderId ? getOrder(orderId) : null;
  if (!order) return pantallaSinDeuda();
  const due = installmentDue(order, Date.now(), { ignorePause: true });
  if (!due) return pantallaSinDeuda();

  if (action === 'INIT' || action === 'BACK') return pantallaAviso(order, due);
  if (action === 'data_exchange') {
    if (screen === 'AVISO') return pantallaPago(order, due);
    return pantallaAviso(order, due);
  }
  return pantallaAviso(order, due);
}

// El JSON de las pantallas vive aparte (sin dependencias) para que
// scripts/setup-wa-flow.js pueda subirlo sin cargar config.js.
export { FLOW_JSON } from './wa-flow-json.js';
