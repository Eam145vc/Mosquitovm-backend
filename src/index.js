// Entrypoint del backend.
// Soporta dos modos en paralelo:
//   - IMAP IDLE (fallback, latencia 5-15s)
//   - Gmail API + Pub/Sub webhook (modo realtime, <3s) - se activa si GMAIL_PUBSUB_TOPIC esta seteado

import { ImapWatcher } from './imap-watcher.js';
import { GmailPoller } from './gmail-poller.js';
import { publishVoice, publishCommand, connect as mqttConnect, close as mqttClose, onSpeakerStatus } from './mqtt-publisher.js';
import { buildVoiceMessage } from './amount-to-wavs.js';
import { markVoicePublished } from './latency.js';
import { startHttp } from './http-server.js';
import { startScheduler as startIgScheduler } from './ig-scheduler.js';
import { startInstallmentsScheduler } from './installments-scheduler.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { openDb, listAccounts, getAccount, getDevice, listDevices } from './storage.js';
import { watchInbox } from './gmail-api.js';
import { updateAccountHistory, updateAccountWatch, recordPayment, upsertDeviceFromStatus,
  setSubStatus, accountsToAutoSuspend, markNewlyExpired, listOrders, updateOrder, getOrder,
  paymentsFor, requeueStaleWa, shipmentsAwaitingTracking, updateShipmentRow, listWaOutbox,
  listShipments, cancelPendingWaByKinds, cancelAllPendingWa, getShipmentByOrder,
  speakersForBank } from './storage.js';
import { onIncident as onBankIncident } from './bank-status.js';
import { filterOnline } from './speaker-online.js';
import { fetchEfiStatus } from './efipay.js';
import { reportPurchasesToMeta } from './meta-capi.js';
import { sendActivationEmail } from './activation-email.js';
import { enqueueWhatsApp, enqueueGuiaCreadaIfReady, GUIA_CREADA_SINCE } from './wa-enqueue.js';
import { getShipment, extractLabel } from './skydropx.js';
import { runWaReminderJob } from './wa-reminders.js';
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
  const at = Date.now(); // MISMO at para memoria y DB
  // Fallback de local para Gmail mono-local (pubsub/imap no pasan por pickSpeaker):
  // el nombre sale del device asignado al speaker de la cuenta.
  let localName = payment.localName || null;
  if (!localName && payment.speakerId) {
    try { localName = getDevice(payment.speakerId)?.local_name || null; } catch { /* noop */ }
  }
  announceLog.record({ accountId: payment.accountId, amount: payment.amount, bank: payment.bank, localName, at });
  // Persistir el pago para el historial del admin y La Libreta (sobrevive reinicios).
  try {
    recordPayment({
      accountId: payment.accountId, amount: payment.amount, bank: payment.bank, payer: payment.payer,
      brebKey: payment.brebKey || null, speakerId: payment.speakerId || null,
      localName, unrouted: false, msgId: payment.messageId || null, at,
    });
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

  // ── Ping getinfo periódico: mantiene last_seen fresco para el online/offline de
  // La Libreta. Solo devices ASIGNADOS (order_id). getinfo es telemetría pura: NO
  // reproduce audio ni flashea (cumple la regla "flashear solo con orden").
  const DEVICE_PING_MS = 5 * 60 * 1000;   // umbral offline 12 min = 2 pings perdidos + margen
  const devicePingJob = () => {
    try {
      // Solo devices de órdenes VIVAS: una orden archivada (cliente dado de baja)
      // no necesita online/offline y pinguearla gasta datos/batería del speaker.
      const targets = listDevices().filter((d) => {
        if (!d.order_id) return false;
        const o = getOrder(d.order_id);
        return o && !o.archived_at;
      });
      for (const [i, d] of targets.entries()) {
        setTimeout(() => {                 // escalonado 500ms: sin ráfaga MQTT
          publishCommand(d.spkr_id, { cmd: 'getinfo' })
            .catch((e) => logger.warn({ spkr: d.spkr_id, err: e.message }, 'ping getinfo falló'));
        }, i * 500);
      }
    } catch (e) { logger.error({ err: e.message }, 'device ping job error'); }
  };
  setTimeout(devicePingJob, 15_000);
  setInterval(devicePingJob, DEVICE_PING_MS);

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
          try { enqueueWhatsApp(fresh, 'activacion'); } catch (e) {
            logger.error({ orderId: o.id, err: e.message }, 'wa: no se pudo encolar activación (conciliación)');
          }
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

  // ── Meta CAPI: Purchase servidor→Meta (ventas que el píxel del navegador no ve:
  // pestaña cerrada tras pagar, QR subido por el admin). Dedupe por event_id=orderId.
  if (config.hasMetaCapi) {
    const metaCapiJob = () => reportPurchasesToMeta().catch((e) =>
      logger.error({ err: e.message }, 'meta-capi job error'));
    metaCapiJob();
    setInterval(metaCapiJob, 5 * 60 * 1000);
  } else {
    logger.info('Meta CAPI apagada (sin META_CAPI_TOKEN en el .env)');
  }

  // ── Recordatorios de onboarding por WhatsApp (3h / 24h) ────────────────────────
  // stepOf: 3 = onboarding completo. confirmedAt: momento del pago, ESTABLE (no usar
  // updated_at: updateOrder lo pisa en cada avance del onboarding —conectar correo,
  // subir qr_path, etc.— y eso reseteaba la "edad desde el pago" en cada paso, matando
  // el recordatorio para quien más lo necesita: el que empezó y no terminó). Se deriva
  // de next_charge_at (se setea SOLO al aprobar el pago / renovar, 365 días a futuro).
  const stepOf = (o) => {
    // El onboarding post-compra es SOLO subir el QR (sin él no se despacha). El correo
    // se conecta cuando el cliente RECIBE el altavoz (link &correo=1 en el WhatsApp de
    // envío), así que estos recordatorios pre-despacho no lo persiguen.
    return o.qr_path ? 3 : 1;
  };
  const YEAR_MS = 365 * 24 * 3600 * 1000;
  const confirmedAt = (o) => {
    if (o.status === 'cod_pending') return o.created_at;      // COD: cuándo se creó la orden
    if (o.next_charge_at) return o.next_charge_at - YEAR_MS;  // online: derivado del pago (estable)
    return o.created_at;                                      // fallback defensivo
  };
  // Corte histórico: ignora órdenes confirmadas antes de esta fecha (evita que el job
  // vuelva a mirar la historia y genere una avalancha como la de las ~124 órdenes viejas).
  // Se lee de env var (no entra a config.js/Zod): si no está seteada, since=0 (comportamiento
  // viejo); en el VM se setea al desplegar este fix.
  const WA_SINCE = Number(process.env.WA_REMINDERS_SINCE) || 0;
  const WA_MAX_AGE = 48 * 3600 * 1000; // tope de antigüedad: no recordar eternamente una orden colgada
  const waReminderJob = () =>
    runWaReminderJob({
      listOrders, stepOf, enqueue: enqueueWhatsApp, confirmedAt, now: Date.now(),
      since: WA_SINCE, maxAgeMs: WA_MAX_AGE,
    });
  waReminderJob();
  setInterval(waReminderJob, 15 * 60 * 1000); // cada 15 min

  // ── Auto-aviso de demoras del banco ─────────────────────────────────────────
  // El detector (bank-status.js, alimentado por la latencia de cada pago) abre un
  // incidente cuando un banco viene lento de forma SOSTENIDA (≥3 pagos lentos en
  // 15 min y mayoría; no un pago aislado). Al abrirse, se reproduce el audio 120
  // ("las notificaciones pueden tardar más de lo normal por demoras del banco")
  // SOLO en los speakers de clientes que reciben pagos de ese banco (últimos 30 días).
  // '120-120' = el aviso suena 2 veces seguidas (los WAV se concatenan por ID),
  // para que se alcance a escuchar aunque el local esté ruidoso.
  const AVISO_DEMORA_WAV = '120-120';
  const BANK_CLIENTS_WINDOW_MS = 30 * 24 * 3600 * 1000;
  onBankIncident(async (bank) => {
    const candidatos = speakersForBank(bank, Date.now() - BANK_CLIENTS_WINDOW_MS);
    if (!candidatos.length) {
      logger.warn({ bank }, 'demoras del banco: sin speakers afectados, no se envía aviso');
      return;
    }
    // SOLO a los que están online AHORA (ping getinfo). Y qos 0: si uno está offline
    // (o se cae justo), el broker NO le guarda el aviso — un "demoras del banco" viejo
    // sonando al reconectar horas después confunde al comerciante.
    const speakers = await filterOnline(candidatos);
    const offline = candidatos.length - speakers.length;
    if (!speakers.length) {
      logger.warn({ bank, offline }, 'demoras del banco: ningún speaker online, aviso no enviado');
      return;
    }
    const results = await Promise.allSettled(
      speakers.map((s) => publishCommand(s, { cmd: 'voice', playAudibleMsg: AVISO_DEMORA_WAV }, { qos: 0 })),
    );
    const enviados = results.filter((r) => r.status === 'fulfilled').length;
    logger.warn({ bank, enviados, offline, total: candidatos.length, speakers }, 'demoras del banco: aviso 120 enviado');
  });

  // ── WhatsApp de guía de envío ────────────────────────────────────────────────
  // El webhook de Skydropx manda 'guia_creada' (guía + revisar datos) con el evento
  // created y 'envio' light al recogerla la transportadora (ver /webhook/skydropx).
  // Este job es el complemento: (a) completa el tracking asíncrono en la fila, y
  // (b) FALLBACK: si a las 24h el webhook nunca disparó la guía creada (evento que
  // no llegó), la manda igual — ningún cliente se queda sin su guía.
  const WA_ENVIO_MAX_AGE = 48 * 3600 * 1000;
  const WA_ENVIO_FALLBACK_MS = 24 * 3600 * 1000;
  const waEnvioJob = async () => {
    try {
      // (a) completar el tracking asíncrono (la guía tarda unos segundos en Skydropx)
      const pend = shipmentsAwaitingTracking(Date.now() - WA_ENVIO_MAX_AGE);
      for (const sh of pend) {
        try {
          if (!sh.skydropx_id) continue;
          const label = extractLabel(await getShipment(sh.skydropx_id));
          if (!label.tracking) continue; // aún no listo
          updateShipmentRow(sh.id, {
            tracking: label.tracking,
            tracking_url: label.trackingUrl || null,
            carrier: label.carrier || sh.carrier || null,
            status: label.labelUrl ? 'label_ready' : sh.status,
          });
        } catch (e) {
          logger.warn({ shipmentId: sh.id, err: e.message }, 'wa: envío job fallo por shipment');
        }
      }
      // (b) fallback 24h: el webhook nunca mandó la guía y el cliente sigue sin ella
      const outbox = listWaOutbox();
      const now = Date.now();
      for (const sh of listShipments()) {
        const age = now - sh.created_at;
        if (age < WA_ENVIO_FALLBACK_MS || age > WA_ENVIO_MAX_AGE) continue;
        if (!sh.tracking) continue;
        // ya entregado o en devolución: mandar la guía a estas alturas no tiene sentido
        if (['delivered', 'in_return'].includes(sh.tracking_status || '')) continue;
        // 'envio' también cuenta: los envíos previos a este cambio recibieron el
        // mensaje viejo (kind 'envio' con toda la info) — no repetirles la guía.
        if (outbox.some((w) => w.order_id === sh.order_id && (w.kind === 'guia_creada' || w.kind === 'envio'))) continue;
        const order = getOrder(sh.order_id);
        // enqueueGuiaCreadaIfReady aplica el corte GUIA_CREADA_SINCE (envíos viejos: no).
        if (order) enqueueGuiaCreadaIfReady(order);
      }
    } catch (e) {
      logger.error({ err: e.message }, 'wa: envío job error');
    }
  };
  waEnvioJob();
  setInterval(waEnvioJob, 10 * 60 * 1000);

  // Devuelve a 'queued' los mensajes 'sending' que la PC dejó colgados >30 min.
  setInterval(() => {
    const n = requeueStaleWa(30 * 60 * 1000);
    if (n) logger.info({ n }, 'wa: mensajes colgados re-encolados');
  }, 10 * 60 * 1000);

  // Barrida de mensajes obsoletos en cola (al arrancar y cada 15 min):
  // - orden ARCHIVADA → se cancela TODO lo pendiente (no se le manda nada);
  // - orden que YA tiene su QR → se cancela el onboarding ("sube tu QR") pendiente.
  // Cubre lo que quedó encolado de ANTES de estos fixes (compras nocturnas con la PC
  // apagada) y cualquier carrera que se escape.
  const ONBOARDING_KINDS = ['activacion', 'recordatorio_3h', 'recordatorio_24h'];
  const waOnboardingSweep = () => {
    try {
      let nOnboarding = 0, nArchived = 0, nGuiaVieja = 0;
      for (const w of listWaOutbox()) {
        if (!['queued', 'sending'].includes(w.status)) continue;
        const o = getOrder(w.order_id);
        if (!o) continue;
        if (o.archived_at) { nArchived += cancelAllPendingWa(w.order_id); continue; }
        if (ONBOARDING_KINDS.includes(w.kind) && o.qr_path) {
          nOnboarding += cancelPendingWaByKinds(w.order_id, [w.kind]);
        }
        // 'guia_creada' en cola de un envío ANTERIOR al corte: cancelarla (pedidos
        // viejos ya gestionados a mano, no hay que mandarles "revisa tus datos").
        if (w.kind === 'guia_creada') {
          const sh = getShipmentByOrder(w.order_id);
          if (!sh || (sh.created_at || 0) < GUIA_CREADA_SINCE) {
            nGuiaVieja += cancelPendingWaByKinds(w.order_id, ['guia_creada']);
          }
        }
      }
      if (nOnboarding) logger.info({ n: nOnboarding }, 'wa: onboarding obsoleto cancelado (órdenes que ya tienen QR)');
      if (nArchived) logger.info({ n: nArchived }, 'wa: mensajes de órdenes archivadas cancelados');
      if (nGuiaVieja) logger.info({ n: nGuiaVieja }, 'wa: guia_creada de envíos viejos cancelada');
    } catch (e) {
      logger.error({ err: e.message }, 'wa: sweep de onboarding error');
    }
  };
  waOnboardingSweep();
  setInterval(waOnboardingSweep, 15 * 60 * 1000);

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
