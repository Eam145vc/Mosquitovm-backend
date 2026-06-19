// Cliente de Gmail API (alternativa a IMAP IDLE).
// Usa OAuth2 con scope mail.google.com/ (mismo que tenemos).
// Funciones:
//   - watchInbox(refreshToken): suscribe al usuario al topic Pub/Sub
//   - fetchHistory(refreshToken, startHistoryId): trae los mensajes nuevos
//   - fetchMessage(refreshToken, messageId): trae el contenido completo

import { google } from 'googleapis';
import { config } from './config.js';
import { logger } from './logger.js';

function makeOAuth2Client(refreshToken) {
  const oauth2 = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

/**
 * Suscribe al INBOX del usuario al topic Pub/Sub.
 * Hay que llamar esto al menos cada 7 dias (Google expira la watch).
 * Devuelve { historyId, expiration } - guardar historyId para fetchHistory despues.
 */
export async function watchInbox(refreshToken) {
  const auth = makeOAuth2Client(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: config.GMAIL_PUBSUB_TOPIC,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    },
  });

  return {
    historyId: res.data.historyId,
    expiration: Number(res.data.expiration), // ms epoch
  };
}

/**
 * Devuelve el historyId actual del buzón (punto de partida para el poll,
 * así no procesamos correos viejos al conectar).
 */
export async function getHistoryId(refreshToken) {
  const auth = makeOAuth2Client(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.getProfile({ userId: 'me' });
  return res.data.historyId;
}

/**
 * Stop watching - util si el usuario revoca o se da de baja.
 */
export async function stopWatch(refreshToken) {
  const auth = makeOAuth2Client(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.stop({ userId: 'me' });
}

/**
 * Trae los cambios del INBOX desde startHistoryId.
 * Returns: Array de IDs de mensajes nuevos.
 */
export async function fetchNewMessageIds(refreshToken, startHistoryId) {
  const auth = makeOAuth2Client(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.history.list({
    userId: 'me',
    startHistoryId: String(startHistoryId),
    historyTypes: ['messageAdded'],
    labelId: 'INBOX',
  });

  const newIds = [];
  for (const h of (res.data.history || [])) {
    for (const added of (h.messagesAdded || [])) {
      if (added.message?.id) newIds.push(added.message.id);
    }
  }
  return { messageIds: newIds, latestHistoryId: res.data.historyId };
}

/**
 * Trae un mensaje completo (raw RFC822 para que mailparser lo procese).
 */
export async function fetchMessageRaw(refreshToken, messageId) {
  const auth = makeOAuth2Client(refreshToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'raw',
  });

  // raw viene en base64url
  const raw = res.data.raw;
  return Buffer.from(raw, 'base64url');
}
