// Escaneo de Gmail por la Gmail API (scope gmail.readonly, sin IMAP).
// Reutilizable por el poller (modo polling) y por el webhook Pub/Sub (modo realtime).
// Trae los mensajes nuevos desde el last_history_id guardado, los parsea y emite el pago.

import { simpleParser } from 'mailparser';
import { logger } from './logger.js';
import { parseEmail } from './parsers/index.js';
import { isDuplicate } from './dedupe.js';
import { updateAccountHistory } from './storage.js';
import { fetchNewMessageIds, fetchMessageRaw } from './gmail-api.js';
import { config } from './config.js';

/** Procesa un mensaje: lo baja en raw, lo parsea y, si es un pago, lo emite. */
export async function processGmailMessage(account, messageId, emitPayment) {
  try {
    if (isDuplicate(`${account.id}:${messageId}`)) return;

    const raw = await fetchMessageRaw(account.refreshToken, messageId);
    const parsed = await simpleParser(raw);

    const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
    const subject = parsed.subject || '';

    if (config.allowedSenders.length > 0) {
      const ok = config.allowedSenders.some((s) => fromAddr.includes(s));
      if (!ok) return;
    }

    const result = parseEmail({ from: fromAddr, subject, text: parsed.text, html: parsed.html });
    if (!result) return;

    logger.info({ id: account.id, fromAddr, subject, messageId, ...result }, 'payment detected (gmail api)');
    emitPayment({ ...result, accountId: account.id, speakerId: account.speaker_id, from: fromAddr, subject, messageId });
  } catch (e) {
    logger.error({ id: account.id, messageId, err: e.message }, 'gmail processMessage failed');
  }
}

/** Escanea los mensajes nuevos desde el último historyId guardado y procesa cada uno. */
export async function scanGmailFromHistory(account, emitPayment) {
  if (!account.last_history_id) return; // sin baseline todavía
  const { messageIds, latestHistoryId } = await fetchNewMessageIds(
    account.refreshToken,
    account.last_history_id,
  );
  for (const mid of messageIds) {
    await processGmailMessage(account, mid, emitPayment);
  }
  if (latestHistoryId) updateAccountHistory(account.id, latestHistoryId);
}
