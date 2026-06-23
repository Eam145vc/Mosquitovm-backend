// Correo de activación: se envía al cliente apenas su pago se confirma, con el link
// para terminar la activación (subir QR, conectar correo, etc.). Es la red de seguridad
// por si cierra la pantalla de "Confirmando tu pago": siempre le queda el link en su correo.
//
// Reutiliza el mismo MX saliente (firmado DKIM) que usa el buzón del admin para responder.

import { config } from './config.js';
import { logger } from './logger.js';

// Evita reenviar el mismo correo dos veces para la misma orden (los pagos se confirman
// por varias vías: respuesta directa, webhook y polling). En memoria: si el proceso se
// reinicia se podría reenviar una vez, lo cual es aceptable.
const sent = new Set();

/**
 * Manda el correo de activación de una orden ya pagada. Idempotente por orden.
 * `order` debe traer: id, business_name, customer_email | mp_payer_email.
 * Devuelve true si lo envió, false si no había a quién o ya se había enviado.
 */
export async function sendActivationEmail(order) {
  if (!order || sent.has(order.id)) return false;
  const to = order.customer_email || order.mp_payer_email;
  if (!to) {
    logger.warn({ orderId: order.id }, 'activación: orden sin correo del cliente, no se envía link');
    return false;
  }
  if (!config.MX_SEND_API_URL || !config.EMAIL_WEBHOOK_SECRET) {
    logger.warn({ orderId: order.id }, 'activación: MX saliente no configurado, no se envía link');
    return false;
  }

  const base = (config.FRONTEND_BASE_URL || 'https://sono.lat').replace(/\/$/, '');
  const link = `${base}/activar-pro?order=${order.id}`;
  const nombre = order.business_name ? order.business_name.split(' ')[0] : '';
  const saludo = nombre ? `Hola ${nombre},` : 'Hola,';

  const text = [
    saludo,
    '',
    'Recibimos tu pago, ¡gracias! 🎉 Tu Sonó está casi listo.',
    '',
    'Para terminar de activarlo (subir tu QR y dejarlo configurado), entra a este enlace:',
    link,
    '',
    'Puedes abrirlo cuando quieras, desde el celular o el computador. Si ya lo completaste, ignora este correo.',
    '',
    '¿Dudas? Respóndenos a este correo o escríbenos por el chat de sono.lat.',
    '',
    'El equipo de Sonó',
    'sono.lat',
  ].join('\n');

  try {
    const resp = await fetch(`${config.MX_SEND_API_URL.replace(/\/$/, '')}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sono-secret': config.EMAIL_WEBHOOK_SECRET },
      body: JSON.stringify({
        fromLocal: 'hola',
        fromName: 'Sonó',
        to,
        subject: 'Termina de activar tu Sonó',
        text,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      logger.error({ orderId: order.id, status: resp.status, data }, 'activación: MX rechazó el envío del link');
      return false;
    }
    sent.add(order.id);
    logger.info({ orderId: order.id, to }, 'activación: link de activación enviado al cliente');
    return true;
  } catch (e) {
    logger.error({ orderId: order.id, err: e.message }, 'activación: error enviando link');
    return false;
  }
}
