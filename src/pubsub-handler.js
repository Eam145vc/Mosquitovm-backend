// Maneja webhooks de Pub/Sub.
//
// Pub/Sub manda HTTP POST a /webhook/gmail con body:
//   {
//     "message": {
//       "data": "<base64>",      <- decoded = { "emailAddress": "...", "historyId": "..." }
//       "messageId": "...",
//       "publishTime": "..."
//     },
//     "subscription": "..."
//   }
//
// Devolvemos 2xx rapido y procesamos en background, para que Pub/Sub
// no retransmita la notificacion.

import { simpleParser } from 'mailparser';
import { logger } from './logger.js';
import { parseEmail } from './parsers/index.js';
import { isDuplicate } from './dedupe.js';
import { getAccountByEmail, updateAccountHistory } from './storage.js';
import { fetchNewMessageIds, fetchMessageRaw } from './gmail-api.js';
import { config } from './config.js';

/**
 * Punto de entrada del webhook Pub/Sub.
 * @param {Object} body            - body del POST
 * @param {Function} emitPayment   - callback con { amount, bank, speakerId, ... }
 */
export async function handlePubSubPush(body, emitPayment) {
  if (!body?.message?.data) {
    logger.warn({ body }, 'pubsub push sin message.data');
    return;
  }

  let notification;
  try {
    const decoded = Buffer.from(body.message.data, 'base64').toString('utf8');
    notification = JSON.parse(decoded);
  } catch (e) {
    logger.warn({ err: e.message }, 'pubsub decode fail');
    return;
  }

  const { emailAddress, historyId } = notification;
  if (!emailAddress || !historyId) {
    logger.warn({ notification }, 'pubsub sin emailAddress/historyId');
    return;
  }

  // Encontrar la cuenta por email
  const account = getAccountByEmail(emailAddress);
  if (!account) {
    logger.warn({ emailAddress }, 'pubsub para email no registrado');
    return;
  }

  // Buscar mensajes nuevos desde el ultimo historyId guardado
  const startHistoryId = account.last_history_id || historyId;

  try {
    const { messageIds, latestHistoryId } = await fetchNewMessageIds(
      account.refreshToken,
      startHistoryId
    );

    logger.info({
      emailAddress,
      newCount: messageIds.length,
      startHistoryId,
      latestHistoryId,
    }, 'gmail history scanned');

    // Procesar cada mensaje
    for (const mid of messageIds) {
      await processMessage(account, mid, emitPayment);
    }

    // Actualizar el historyId guardado para la proxima
    if (latestHistoryId) {
      updateAccountHistory(account.id, latestHistoryId);
    }
  } catch (e) {
    logger.error({ err: e.message, emailAddress }, 'pubsub fetch history fail');
  }
}

async function processMessage(account, messageId, emitPayment) {
  try {
    if (isDuplicate(`${account.id}:${messageId}`)) return;

    const raw = await fetchMessageRaw(account.refreshToken, messageId);
    const parsed = await simpleParser(raw);

    const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
    const subject = parsed.subject || '';

    if (config.allowedSenders.length > 0) {
      const ok = config.allowedSenders.some(s => fromAddr.includes(s));
      if (!ok) return;
    }

    const result = parseEmail({
      from: fromAddr, subject,
      text: parsed.text, html: parsed.html,
    });
    if (!result) return;

    logger.info({ id: account.id, fromAddr, subject, messageId, ...result }, 'payment detected');
    emitPayment({
      ...result,
      speakerId: account.speaker_id,
      from: fromAddr,
      subject,
      messageId,
    });
  } catch (e) {
    logger.error({ id: account.id, messageId, err: e.message }, 'processMessage failed');
  }
}
