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
    '¡Gracias por tu compra! 🎉 Tu Sonó ya casi está listo para empezar a anunciar tus ventas.',
    '',
    'Solo falta un paso: subir tu QR de Bre-B. Lo imprimimos y te lo enviamos junto a tu altavoz, listo para pegar. Toma 2 minutos, desde tu celular.',
    '',
    'Entra aquí para subirlo:',
    link,
    '',
    'Puedes abrirlo cuando quieras. Si ya lo completaste, ignora este correo.',
    '',
    '¿Dudas? Respóndenos a este correo o escríbenos por el chat de sono.lat.',
    '',
    'El equipo de Sonó',
    'sono.lat',
  ].join('\n');

  // Versión HTML con marca: puntúa mejor en los filtros que el texto plano + link crudo
  // (estructura por tablas para compatibilidad con clientes de correo; botón con texto ancla).
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0f1f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #0a0f1f12;">
        <tr><td style="background:#000d28;padding:24px 28px;">
          <span style="color:#fafaf7;font-size:20px;font-weight:700;letter-spacing:-0.02em;">Sonó</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">${saludo}</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">¡Gracias por tu compra! 🎉 Tu Sonó ya casi está listo para empezar a anunciar tus ventas.</p>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">Solo falta un paso: <strong>subir tu QR de Bre-B</strong>. Lo imprimimos y te lo enviamos junto a tu altavoz, listo para pegar. Toma 2 minutos, desde tu celular.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;"><tr><td style="border-radius:12px;background:#18a848;">
            <a href="${link}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">Subir mi QR &rarr;</a>
          </td></tr></table>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#4a5168;">Puedes abrirlo cuando quieras. Si ya lo completaste, ignora este correo.</p>
          <p style="margin:0;font-size:13px;line-height:1.5;color:#4a5168;">¿Dudas? Respóndenos a este correo o escríbenos por el chat de <a href="https://sono.lat" style="color:#0d8a36;">sono.lat</a>.</p>
        </td></tr>
        <tr><td style="padding:20px 28px;border-top:1px solid #0a0f1f0f;">
          <p style="margin:0;font-size:13px;color:#4a5168;">El equipo de Sonó<br><a href="https://sono.lat" style="color:#0d8a36;text-decoration:none;">sono.lat</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    const resp = await fetch(`${config.MX_SEND_API_URL.replace(/\/$/, '')}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sono-secret': config.EMAIL_WEBHOOK_SECRET },
      body: JSON.stringify({
        fromLocal: 'hola',
        fromName: 'Sonó',
        to,
        subject: 'Sube tu QR para enviarte tu Sonó',
        text,
        html,
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
