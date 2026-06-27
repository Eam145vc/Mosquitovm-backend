// Entrypoint del backend.
// Soporta dos modos en paralelo:
//   - IMAP IDLE (fallback, latencia 5-15s)
//   - Gmail API + Pub/Sub webhook (modo realtime, <3s) - se activa si GMAIL_PUBSUB_TOPIC esta seteado

import { ImapWatcher } from './imap-watcher.js';
import { GmailPoller } from './gmail-poller.js';
import { publishVoice, connect as mqttConnect, close as mqttClose, onSpeakerStatus } from './mqtt-publisher.js';
import { buildVoiceMessage } from './amount-to-wavs.js';
import { markVoicePublished } from './latency.js';
import { startHttp } from './http-server.js';
import { startScheduler as startIgScheduler } from './ig-scheduler.js';
import { startInstallmentsScheduler } from './installments-scheduler.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { openDb, listAccounts, getAccount } from './storage.js';
import { watchInbox } from './gmail-api.js';
import { updateAccountHistory, updateAccountWatch, recordPayment, upsertDeviceFromStatus,
  setSubStatus, accountsToAutoSuspend, markNewlyExpired, listOrders, updateOrder, getOrder } from './storage.js';
import { fetchEfiStatus } from './efipay.js';
import { sendActivationEmail } from './activation-email.js';
import * as announceLog from './announce-log.js';

const watchers = new Map();   // id -> ImapWatcher (modo IMAP)

async function announcePayment(payment) {
  // EGRESOS ("Transferiste $X"): solo se anuncian si la cuenta tiene activada
  // la flag announce_outgoing (futuro toggle en el panel de usuario). No se
  // registran en el historial de pagos (son plata que sale, no ventas).
  if (payment.direction === 'out') {
    const acc = payment.accountId ? getAccount(payment.accountId) : null;
    if (!acc || !acc.announce_outgoing || acc.sub_status === 'suspendida') {
      logger.info({ accountId: payment.accountId, amount: payment.amount },
        'egreso detectado: NO anunciado (announce_outgoing apagado)');
      return;
    }
    try {
      const playAudibleMsg = buildVoiceMessage({ amount: payment.amount, direction: 'out', includeBank: false });
      logger.info({ playAudibleMsg, speakerId: payment.speakerId, ...payment }, 'announcing OUTGOING transfer');
      await publishVoice(playAudibleMsg, { amount: payment.amount, speakerId: payment.speakerId });
    } catch (e) {
      logger.error({ err: e.message }, 'announce outgoing failed');
    }
    return;
  }

  // Registrar para el "altavoz web" (/demo) además de publicar al speaker físico.
  announceLog.record({ accountId: payment.accountId, amount: payment.amount, bank: payment.bank });
  // Persistir el pago para el historial del admin (sobrevive reinicios).
  try {
    recordPayment({ accountId: payment.accountId, amount: payment.amount, bank: payment.bank, payer: payment.payer });
  } catch (e) {
    logger.warn({ err: e.message }, 'no se pudo persistir el pago');
  }
  // Suscripción suspendida → registramos el pago pero NO lo anunciamos en voz.
  if (payment.accountId) {
    const acc = getAccount(payment.accountId);
    if (acc && acc.sub_status === 'suspendida') {
      logger.info({ accountId: payment.accountId }, 'cuenta suspendida: pago registrado, NO anunciado');
      return;
    }
  }
  try {
    const playAudibleMsg = buildVoiceMessage({
      amount: payment.amount,
      bank: payment.bank,
      includeBank: false,   // NO decir el banco: solo "Recibiste X pesos" (+ earcon)
    });
    logger.info({ playAudibleMsg, speakerId: payment.speakerId, ...payment }, 'announcing payment');
    await publishVoice(playAudibleMsg, { amount: payment.amount, speakerId: payment.speakerId });
    // Cierra la medición de latencia del pipeline (solo si vino del webhook FE).
    if (payment._lat) {
      markVoicePublished(payment._lat, {
        accountId: payment.accountId, amount: payment.amount, bank: payment.bank, source: 'fe-webhook',
        brebKey: payment.brebKey || null, alias: payment.alias || null, account: payment.account || null,
      });
    }
  } catch (e) {
    logger.error({ err: e.message }, 'announce failed');
  }
}

// Arranca un ImapWatcher a partir de una fila de account (con refreshToken/imapPass ya descifrados).
async function startImapWatcher(account) {
  const id = account.id;
  if (watchers.has(id)) return;
  const w = new ImapWatcher({
    id,
    email: account.email,
    refreshToken: account.refreshToken,
    speakerId: account.speaker_id,
    authType: account.auth_type || 'oauth',
    provider: account.oauth_provider || 'google',
    imapHost: account.imap_host,
    imapPort: account.imap_port,
    imapUser: account.imap_user,
    imapPass: account.imapPass,
  });
  w.on('payment', announcePayment);
  try {
    await w.start();
    watchers.set(id, w);
  } catch (e) {
    logger.error({ id, err: e.message }, 'watcher failed to start');
  }
}

// Arranca un GmailPoller (Gmail API, scope readonly) para una cuenta Google.
async function startGmailPoller(account) {
  const id = account.id;
  if (watchers.has(id)) return;
  const p = new GmailPoller(account);
  p.on('payment', announcePayment);
  try {
    await p.start();
    watchers.set(id, p);
  } catch (e) {
    logger.error({ id, err: e.message }, 'gmail poller failed to start');
  }
}

// Decide cómo vigilar una cuenta: IMAP (manual/Microsoft), Gmail Pub/Sub o Gmail poller.
async function startForAccount(full, usingPubSub) {
  // Método "correo redirigido": el ingreso es por webhook (Cloudflare Email Worker),
  // NO se vigila ningún buzón. No arrancar watcher.
  if (full.oauth_provider === 'redirect') {
    logger.info({ id: full.id, alias: full.alias }, 'cuenta redirect: sin watcher (ingreso por webhook)');
    return;
  }
  if (full.auth_type === 'imap' || full.oauth_provider === 'microsoft') {
    await startImapWatcher(full);
  } else if (usingPubSub) {
    await renewWatchIfNeeded(full);
  } else {
    await startGmailPoller(full); // Gmail por API (gmail.readonly), no IMAP
  }
}

async function renewWatchIfNeeded(account) {
  // Renovar si expira en menos de 24h
  if (!account.watch_expires || account.watch_expires - Date.now() < 24 * 3600 * 1000) {
    try {
      const w = await watchInbox(account.refreshToken);
      updateAccountHistory(account.id, w.historyId);
      updateAccountWatch(account.id, w.expiration);
      logger.info({ id: account.id, historyId: w.historyId }, 'gmail watch renewed');
    } catch (e) {
      logger.error({ id: account.id, err: e.message }, 'watch renewal failed');
    }
  }
}

async function main() {
  const usingPubSub = Boolean(config.GMAIL_PUBSUB_TOPIC);
  logger.info({ mode: usingPubSub ? 'PubSub' : 'IMAP' }, 'starting backend');
  openDb();

  // Auto-provisioning: cuando un speaker reporta por speakers/<id>/status, lo
  // registramos/actualizamos solo (lee MAC/IMEI/señal). Aparece en el admin sin tipear.
  onSpeakerStatus((spkrId, info) => {
    try {
      const r = upsertDeviceFromStatus(spkrId, info);
      if (r?.created) logger.info({ spkrId, mac: info.mac }, 'speaker auto-registrado');
    } catch (e) {
      logger.warn({ err: e.message, spkrId }, 'auto-provisioning fallo');
    }
  });

  mqttConnect();

  const accounts = listAccounts();
  logger.info({ count: accounts.length, mode: usingPubSub ? 'PubSub' : 'IMAP' }, 'accounts en DB');

  for (const a of accounts) {
    const full = getAccount(a.id);
    if (!full) continue;

    await startForAccount(full, usingPubSub);
  }

  // HTTP server con callback al conectar correo + webhook Pub/Sub
  startHttp(
    async (accountId) => {
      const full = getAccount(accountId);
      if (full) await startForAccount(full, usingPubSub);
    },
    announcePayment,   // callback para que el webhook anuncie pagos
    (accountId, status) => {  // cambio de suscripción (suspender/reactivar)
      // El gate de anuncio se hace en announcePayment leyendo sub_status, así que
      // no hace falta parar/arrancar watchers. Solo logueamos.
      logger.info({ accountId, status }, 'sub_status cambiado desde el admin');
    },
  );

  // Job diario: marcar vencidos (setea gracia) y auto-suspender los que pasaron
  // los 3 días de gracia. Corre al arrancar y cada 6h.
  const autoSuspendJob = () => {
    try {
      const newly = markNewlyExpired();
      if (newly) logger.info({ count: newly }, 'cuentas marcadas vencidas (en gracia)');
      const toSuspend = accountsToAutoSuspend();
      for (const r of toSuspend) {
        setSubStatus(r.account_id, 'suspendida');
        logger.info({ accountId: r.account_id }, 'cuenta auto-suspendida (gracia vencida)');
      }
    } catch (e) {
      logger.error({ err: e.message }, 'auto-suspend job error');
    }
  };
  autoSuspendJob();
  setInterval(autoSuspendJob, 6 * 3600 * 1000);

  // ── Conciliación de pagos EfiPay (red de seguridad PROACTIVA) ──────────────────
  // Problema que resuelve: si un cliente paga por PSE/Nequi/Bre-B (redirect) y CIERRA
  // la pestaña sin volver a la pantalla "Confirmando tu pago", el webhook de EfiPay
  // puede no llegar y la orden queda en 'created' ("Sin pagar") AUNQUE EfiPay ya cobró.
  // (La red de seguridad de /activar solo dispara si el cliente reabre la pantalla.)
  // Este job recorre cada 5 min las órdenes 'created' con efi_payment_id, consulta el
  // estado REAL en EfiPay y, si está aprobado, las pasa a 'pendiente_qr' Y dispara el
  // correo de activación (mismo efecto que un pago normal). Idempotente: solo toca las
  // que siguen en 'created' y que EfiPay confirma como aprobadas.
  const reconcileEfipayJob = async () => {
    try {
      const pend = listOrders().filter((o) => o.status === 'created' && o.efi_payment_id);
      if (!pend.length) return;
      let fixed = 0;
      for (const o of pend) {
        try {
          const st = await fetchEfiStatus(o.efi_payment_id);
          if (!st?.approved) continue; // Rechazada/Pendiente → no se toca
          const nextCharge = Date.now() + 365 * 24 * 3600 * 1000;
          updateOrder(o.id, {
            status: 'pendiente_qr',
            wompi_txn_id: `efi-reconcile-${o.efi_payment_id}`,
            next_charge_at: nextCharge,
          });
          const fresh = getOrder(o.id);
          // Dispara el correo de activación (el cliente recibe el link para el onboarding).
          sendActivationEmail(fresh).catch((e) =>
            logger.error({ orderId: o.id, err: e.message }, 'conciliación EfiPay: correo de activación falló'));
          fixed += 1;
          logger.warn({ orderId: o.id, paymentId: o.efi_payment_id, business: o.business_name },
            'conciliación EfiPay: pago APROBADO no reflejado → marcado pendiente_qr + correo enviado');
        } catch (e) {
          logger.warn({ orderId: o.id, err: e.message }, 'conciliación EfiPay: fallo al consultar estado (reintenta)');
        }
      }
      if (fixed) logger.info({ fixed }, 'conciliación EfiPay: órdenes recuperadas');
    } catch (e) {
      logger.error({ err: e.message }, 'conciliación EfiPay job error');
    }
  };
  reconcileEfipayJob();                              // corre una vez al arrancar (recupera lo pendiente)
  setInterval(reconcileEfipayJob, 5 * 60 * 1000);   // y cada 5 minutos

  // Scheduler de posts de Instagram programados (publica los que ya vencieron, cada 60s).
  startIgScheduler();

  // Scheduler de cobro de cuotas 2-3 (plan "cuotas"): cobra con la tarjeta tokenizada
  // las cuotas vencidas, cada hora. Al 3er fallo suspende el servicio.
  startInstallmentsScheduler();

  // Renovar watches cada 12h (Google expira a 7 dias)
  if (usingPubSub) {
    setInterval(async () => {
      for (const a of listAccounts()) {
        const full = getAccount(a.id);
        if (full) await renewWatchIfNeeded(full);
      }
    }, 12 * 3600 * 1000);
  }

  const shutdown = async () => {
    logger.info('shutting down...');
    for (const w of watchers.values()) await w.stop();
    mqttClose();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  logger.error({ err: e.message, stack: e.stack }, 'fatal');
  process.exit(1);
});
