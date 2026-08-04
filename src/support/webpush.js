// Web Push (VAPID) para notificar al dueño en su iPhone (PWA en el escritorio).
//
// Usa la librería 'web-push'. Las claves VAPID se generan una vez con:
//   npx web-push generate-vapid-keys
// y se ponen en VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. La pública también la usa el
// frontend (la sirve /soporte/vapid-public) para suscribir el navegador.

import webpush from 'web-push';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { listPushSubs, deletePushSub } from './support-store.js';

let ready = false;

function ensure() {
  if (ready) return true;
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    config.VAPID_SUBJECT || 'mailto:hola@sono.lat',
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY,
  );
  ready = true;
  return true;
}

export function pushEnabled() {
  return Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
}

/**
 * Manda una notificación push a los dispositivos admin suscritos.
 * payload: { title, body, url, tag }
 * opts.ownerOnly: excluye al operario (para el push de venta, que es solo del dueño).
 */
export async function notifyAdmins(payload, opts = {}) {
  if (!ensure()) {
    logger.warn('web push sin VAPID configurado; no se envía notificación');
    return { sent: 0 };
  }
  let subs = listPushSubs();
  if (opts.ownerOnly) subs = subs.filter((s) => (s.role || 'owner') !== 'operator');
  if (!subs.length) return { sent: 0 };

  const data = JSON.stringify({
    title: payload.title || 'Sonó Soporte',
    body: payload.body || '',
    url: payload.url || '/soporte-app/',
    tag: payload.tag || 'sono-soporte',
    sound: payload.sound || null, // 'cash' = cha-ching de venta (lo reproduce la PWA abierta)
  });

  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };
    try {
      await webpush.sendNotification(subscription, data);
      sent++;
    } catch (e) {
      // 404/410 = suscripción muerta → limpiar.
      if (e.statusCode === 404 || e.statusCode === 410) {
        deletePushSub(s.endpoint);
        logger.info({ endpoint: s.endpoint.slice(0, 40) }, 'push sub vencida, eliminada');
      } else {
        logger.warn({ status: e.statusCode, err: e.message }, 'push send fail');
      }
    }
  }));
  return { sent };
}
