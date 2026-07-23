// Avisos por Telegram al dueño (Sono_co_bot, mismo bot del uptime monitor).
// Razón de ser: Web Push no permite sonido custom con la PWA cerrada; en Telegram
// el dueño le pone el cha-ching como sonido de ese chat y suena con todo cerrado.

import { config } from './config.js';
import { logger } from './logger.js';

export async function sendTelegram(text) {
  if (!config.hasTelegram) return { ok: false, reason: 'sin TG_BOT_TOKEN/TG_CHAT_ID' };
  const res = await fetch(`https://api.telegram.org/bot${config.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.TG_CHAT_ID, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    logger.warn({ status: res.status, desc: body.description }, 'telegram send fail');
    return { ok: false };
  }
  return { ok: true };
}
