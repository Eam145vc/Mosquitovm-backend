// HTTP server: checkout MercadoPago + onboarding (Gmail OAuth / IMAP manual) + QR + envio + admin.
//
// Comercio / wizard:
//   POST /checkout/create            - crea orden con los datos de envio
//   POST /checkout/pay               - procesa el pago in-web (Payment Brick de MercadoPago)
//   POST /webhook/mp                 - webhook de MercadoPago; marca la orden pagada
//   GET  /activar/:order             - estado de la orden (para el wizard)
//   GET  /onboard?order=REF          - inicia OAuth Gmail para una orden
//   GET  /auth/callback?code=...     - recibe code de Google, linkea correo, redirige al wizard
//   POST /activar/:order/email-imap  - conecta un correo no-Gmail por IMAP manual
//   POST /activar/:order/qr          - sube la imagen del QR del banco (multipart)
//   POST /activar/:order/shipping    - guarda datos de envio
//
// Admin (fulfillment / inventario, auth Bearer ADMIN_TOKEN):
//   GET  /admin/orders               - lista de ordenes
//   GET  /admin/orders/:order/qr     - descarga el QR para imprimir
//   POST /admin/orders/:order/device - asigna un device a la orden (vincula speaker)
//   GET  /admin/devices              - inventario de speakers
//   POST /admin/devices              - registra una unidad al provisionar
//
// Otros:
//   POST /webhook/gmail              - webhook Pub/Sub de Gmail
//   POST /test-voice                 - manda voice de prueba al speaker
//   GET  /accounts                   - lista accounts (debug)
//   GET  /healthz

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import { ImapFlow } from 'imapflow';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { buildAuthUrl, exchangeCodeForTokens } from './oauth.js';
import {
  buildAuthUrl as msBuildAuthUrl,
  exchangeCodeForTokens as msExchangeCodeForTokens,
} from './oauth-microsoft.js';
import {
  upsertAccount, listAccounts, getAccount, getAccountByEmail, getAccountByAlias, setAccountSpeaker,
  createOrder, getOrder, getOrderByPlanId, updateOrder, listOrders,
  createDevice, getDevice, listDevices, assignDevice, unassignDevice, setDeviceStatus,
  setDeviceBrebKey, listDevicesByAccount, findDeviceByKey,
  listDeviceKeys, addDeviceKey, removeDeviceKey,
  updateAccountHistory, updateAccountWatch, setAccountForward, findAccountByForward, markChangeConfirmed,
  setAccountOnlyBreb, getAccountByEmailCI,
  resetChangeConfirmed, renameAccountAlias,
  paymentsFor, subState, setSubStatus,
  recordPayment, paymentsAggregate, bestHours, paymentsAfter, paymentsPage, paymentsPageRange,
  saveInboxMail, listInbox, getInboxMail, markInboxSeen, deleteInboxMail, unseenInboxCount,
  markInboxReplied, saveOutboundMail,
  claimWaPending, markWaSent,
  touchWaAgent, getWaSettings, setWaSettings, getWaAgentLastSeen, countWaByStatus,
  listWaOutbox, requeueWa, cancelWa, cancelPendingWaByKinds, cancelAllPendingWa,
  insertWaInbound, listWaInbound, updateWaDeliveryByWamid, countWaSentSince, setWaInboundMedia,
  getShipmentByOrder, updateShipmentRow, renameDeviceLocal, listShipments,
  insertUgcApplication, listUgcApplications, countUgcNuevo, setUgcStatus, deleteUgcApplication,
  createPaymentIntent, getPaymentIntent, matchPaymentIntent,
  speakersForBank,
} from './storage.js';
import { bogotaDayStart, bogotaDayStartFromKey, bogotaMonthStart, bogotaPrevMonthStart, DAY_MS } from './libreta-time.js';
import { getShipment, extractLabel, fetchLabelPdf } from './skydropx.js';
import { scanBrebImage, decodeBrebImage, normalizeKey } from './breb-qr.js';
import { parseEmail } from './parsers/index.js';
import { simpleParser } from 'mailparser';
import { generateAlias, createClientAlias, updateClientAliasRecipients } from './forwardemail.js';
import { maybeCaptureOtp, readOtp, clearOtp } from './otp-capture.js';
import { isDuplicate } from './dedupe.js';
import { isChangeConfirmation } from './change-confirm.js';
import { isTrustedBankEmail, isKnownBankSender } from './sender-filter.js';
import { forwardPayment, paymentRedirectUrl, fetchPayment, paymentIdFromWebhook, createPreference } from './mercadopago.js';
import { createStripeCheckout, fetchStripeSession } from './stripe.js';
import { generatePaymentLink, chargeCard, chargePse, chargeBreb, chargeCash, getResource, fetchEfiTransaction, fetchEfiStatus, isValidEfiWebhook, parseEfiWebhook, tokenizeCard } from './efipay.js';
import * as announceLog from './announce-log.js';
import { sendActivationEmail } from './activation-email.js';
import { enqueueWhatsApp, enqueueWhatsAppForce, normalizePhoneCO, ESTADOS_SIN_MENSAJES } from './wa-enqueue.js';
import { isWaCloudActive, downloadWaMedia } from './wa-cloud.js';
import { bogotaHour, startOfBogotaDay, withinActiveHours } from './wa-shared.js';
import { notifyAdmins } from './support/webpush.js';
import { notifySale } from './sale-push.js';
import { CUOTA_2_3_CENTS } from './installments-scheduler.js';
import { publishVoice, publishCommand } from './mqtt-publisher.js';
import { buildVoiceMessage } from './amount-to-wavs.js';
import { startLatency, markVoicePublished } from './latency.js';
import { getStats as getLatencyStats } from './latency-store.js';
import { snapshot as bankStatusSnapshot } from './bank-status.js';
import { filterOnline } from './speaker-online.js';
import { handlePubSubPush } from './pubsub-handler.js';
import { watchInbox } from './gmail-api.js';
import { registerSupportRoutes } from './support/support-routes.js';
import { registerSkydropxRoutes } from './skydropx-routes.js';
import { searchCities, cityByDane } from './co-dane.js';
import { publishToInstagram, getInstagramAccount, getInstagramMedia } from './instagram.js';
import { generateCaption } from './ig-caption.js';
import * as igScheduler from './ig-scheduler.js';

const QR_DIR = path.join(path.dirname(config.DB_PATH), 'qr');
fs.mkdirSync(QR_DIR, { recursive: true });

// Archivos temporales para publicar en Instagram. Graph DESCARGA la imagen/video desde
// una URL pública, así que guardamos el archivo acá y lo servimos en /ig-media/<file>.
// Se borran tras publicar.
const IG_DIR = path.join(path.dirname(config.DB_PATH), 'ig-media');
fs.mkdirSync(IG_DIR, { recursive: true });

const PAID_STATES = ['paid', 'pendiente_qr', 'ready_to_ship', 'shipped'];
const isPaid = (o) => o && PAID_STATES.includes(o.status);
// Contraentrega (COD): la orden NO está pagada aún (paga al recibir), pero el
// cliente SÍ puede hacer el onboarding de una vez (conectar correo + subir QR).
// El Purchase al pixel se dispara solo al completar (step>=3), lo controla el front.
const isCod = (o) => o && o.status === 'cod_pending';
// Puede hacer onboarding = ya pagó (online) o es COD (paga al recibir).
const canOnboard = (o) => isPaid(o) || isCod(o);

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'application/pdf': 'pdf',
};

/** Vista publica de una orden (sin datos sensibles), con el paso actual del wizard.
 *  El envio se recoge ANTES de pagar (checkout), asi que el post-pago son 2 pasos:
 *  1=qr, 2=correo, 3=listo.
 *  OJO: /activar-pro trata step>=2 como onboarding COMPLETO (solo pide el QR; el correo
 *  se conecta al recibir el altavoz, vía &correo=1). El flujo de 2 pasos completo solo
 *  lo usa /activar (la ruta que revisa Google para el OAuth de Gmail). */
function orderView(o) {
  // El correo cuenta como LISTO solo si hay PRUEBA de que el reenvío funciona: o el banco
  // confirmó el cambio (change_confirmed), o ya llegó al menos un pago por esa cuenta.
  // Tener account_id NO basta: el cliente pudo poner su correo y crear la cuenta, pero si
  // no completó el cambio en el banco, no cuenta como email listo (si no, saltaría a "listo"
  // sin que los pagos lleguen de verdad).
  const acc = o.account_id ? getAccount(o.account_id) : null;
  const hasReceivedPayment = o.account_id ? paymentsFor(o.account_id, 1).length > 0 : false;
  const emailReady = Boolean(acc && (acc.change_confirmed || hasReceivedPayment));
  // Orden del wizard: 1=subir QR (sin requisito previo), 2=conectar correo (se desbloquea
  // al tener el QR), 3=listo (QR + correo).
  const qrReady = Boolean(o.qr_path);
  let step = 1;
  if (qrReady) step = 2;
  if (qrReady && emailReady) step = 3;
  return {
    order: o.id,
    // COD reporta paid:true para que el front deje entrar al wizard (el candado real
    // de "conversión" lo pone el front: en COD solo dispara Purchase con step>=3).
    paid: canOnboard(o),
    // realmente cobrado (online). El front NO lo usa para el Purchase de COD, pero
    // sirve para distinguir "pagado de verdad" de "COD en onboarding".
    reallyPaid: isPaid(o),
    cod: isCod(o),
    status: o.status,
    step,
    emailMethod: o.email_method || null,
    hasEmail: emailReady,
    emailConnected: Boolean(o.account_id), // cuenta creada (correo puesto), aunque no confirmado
    hasQr: Boolean(o.qr_path),
    hasShipping: Boolean(o.business_name),
    payerEmail: o.mp_payer_email || null,  // para pre-rellenar el correo del método redirect
    customerEmail: o.customer_email || null, // correo del checkout, para prellenar el onboarding
    // Destino REAL del reenvío si la cuenta redirect ya existe. El front lo precarga con
    // prioridad sobre customerEmail: el correo del checkout puede NO ser el del banco
    // (incidente Ricardo jul-2026: el link mostraba el de la orden y pisaba el corregido).
    forwardTo: acc?.forwardTo || null,
    delivery: o.delivery || 'online', // 'online' | 'contraentrega' → el front decide cuándo reportar el Purchase a los pixels
    // Monto en pesos, para el value del Purchase de los pixels. El front antes lo sacaba
    // de localStorage (se pierde si el cliente abre el link en OTRO dispositivo → 24% de
    // Purchases sin value según Meta); la DB es la fuente real.
    amount: Math.round((o.amount_cents || 0) / 100),
  };
}

// `opts.listen = false` construye la app SIN abrir el puerto: lo usan los tests
// con app.inject() de Fastify (la app se devuelve igual en ambos modos).
export function startHttp(onAccountAdded, onPaymentDetected, onSubStatusChange, { listen = true } = {}) {
  // trustProxy '127.0.0.1': SOLO se confía el x-forwarded-for cuando el peer directo
  // es loopback (Caddy local en el VM). Así req.ip es la IP REAL del cliente y los
  // rate limits "por IP" de La Libreta dejan de ser globales; y un atacante que
  // llegue directo al puerto 47821 NO puede spoofear XFF (su peer no es loopback).
  const app = Fastify({ logger: false, trustProxy: '127.0.0.1', bodyLimit: 10 * 1024 * 1024 }); // 10MB para correos de ForwardEmail

  // Orígenes permitidos: el front principal (sono.lat) + orígenes extra de la web
  // espejo (sonoback.com y su deploy en Railway). CORS_EXTRA_ORIGINS es una lista
  // separada por comas en el .env; se filtra vacío por si no está definida.
  const corsOrigins = [
    config.FRONTEND_BASE_URL,
    'https://sonoback.com',
    'https://www.sonoback.com',
    'https://espejosono-production.up.railway.app',
    ...(process.env.CORS_EXTRA_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ];
  app.register(fastifyCors, {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
  });
  // 100MB: el QR son KBs, pero un reel de Instagram puede pesar decenas de MB.
  app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024, files: 12 } });

  const requireAdmin = (req, reply) => {
    if (!config.ADMIN_TOKEN) { reply.code(503).send({ error: 'admin disabled' }); return false; }
    if ((req.headers.authorization || '') !== `Bearer ${config.ADMIN_TOKEN}`) {
      reply.code(401).send({ error: 'unauthorized' }); return false;
    }
    return true;
  };

  // Linkea una cuenta a su orden al conectar el correo, y HEREDA el speaker que
  // ya estaba asignado a la orden (asignación previa al onboarding). Así, cuando
  // el cliente conecta su correo, su cuenta queda con el speaker correcto y el
  // sistema empieza a anunciar sus pagos sin un paso manual extra.
  const linkOrderToAccount = (order, accountId, method) => {
    updateOrder(order.id, { account_id: accountId, email_method: method });
    const assignedDev = listDevices().find((d) => d.order_id === order.id);
    if (assignedDev) {
      setAccountSpeaker(accountId, assignedDev.spkr_id);
      logger.info({ orderId: order.id, accountId, spkr_id: assignedDev.spkr_id }, 'speaker heredado de la orden a la cuenta');
    }
  };

  // RUTEO MULTIPUNTO: decide en QUÉ speaker suena un pago.
  //  - Cuenta con 1 (o 0) device → el speaker de la cuenta (comportamiento de siempre).
  //  - Cuenta con 2+ devices (varios locales) → match por la llave Bre-B del pago:
  //      match → el speaker de ese local; sin match → null (NO suena, para no confundir).
  // Devuelve { speakerId } si hay que anunciar, o { speakerId: null, unrouted: true } si no.
  // `deviceKey` = llave Bre-B registrada del local que sonó (del QR subido): sirve para
  // atribuir la llave a pagos cuyo correo no la trae (Nequi/Daviplata no la incluyen).
  const pickSpeaker = (account, payment) => {
    const devices = listDevicesByAccount(account.id);
    if (devices.length <= 1) {
      // un solo local: suena en su speaker (el de la cuenta o el único device).
      // localName acompaña al pago hasta La Libreta (etiqueta del local).
      return {
        speakerId: account.speaker_id || (devices[0] && devices[0].spkr_id) || null,
        deviceKey: (devices[0] && devices[0].breb_key) || null,
        localName: (devices[0] && devices[0].local_name) || null,
      };
    }
    // multipunto: rutear por llave.
    const key = payment.brebKey ? normalizeKey(payment.brebKey) : null;
    if (key) {
      const dev = findDeviceByKey(account.id, key);
      if (dev) return { speakerId: dev.spkr_id, localName: dev.local_name, deviceKey: dev.breb_key };
    }
    // sin llave parseable o llave que no coincide con ningún local → NO suena + aviso.
    return { speakerId: null, unrouted: true, key };
  };

  // FILTRO "solo pagos por llave Bre-B" (account.only_breb): cuando el cliente quiere
  // que NO le suenen las transferencias directas por número de cuenta, solo lo que entra
  // por su llave Bre-B. El correo Bre-B de Bancolombia trae "conectado a la llave X"
  // (result.brebKey queda seteado); una transferencia directa no la trae → se silencia.
  // ⚠️ SOLO Bancolombia: Nequi/BBVA no incluyen la llave en el correo, así que ahí el
  // filtro se ignora (si no, silenciaría TODO). Devuelve true si hay que ignorar el pago.
  const dropByOnlyBreb = (account, result) =>
    Boolean(account.only_breb) && result.direction === 'in'
      && result.bank === 'bancolombia' && !result.brebKey;

  // CHECKOUT BRE-B PROPIO: los pagos que entran a la cuenta de pagos de Sonó
  // (SONO_PAGOS_ALIAS) se matchean por MONTO contra los intents pendientes del
  // checkout (ventana de 2 min + gracia). Match → la orden queda pagada, igual
  // que con el webhook de EfiPay. Sin match → warn para conciliar a mano.
  // Corre DESPUÉS de despachar el anuncio (el speaker no espera al checkout).
  const settleOwnBrebPayment = (alias, result) => {
    if (!config.hasOwnBreb || alias !== config.SONO_PAGOS_ALIAS) return;
    if (!result || result.direction === 'out' || !result.amount) return;
    try {
      const intent = matchPaymentIntent(result.amount, { bank: result.bank || null });
      if (!intent) {
        logger.warn({ alias, amount: result.amount, bank: result.bank },
          'breb propio: pago a la cuenta Sonó sin intent que matchee (conciliar a mano)');
        return;
      }
      const order = getOrder(intent.order_id);
      if (!order) { logger.error({ intentId: intent.id, orderId: intent.order_id }, 'breb propio: intent sin orden'); return; }
      if (isPaid(order)) { logger.info({ orderId: order.id, intentId: intent.id }, 'breb propio: la orden ya estaba pagada'); return; }
      updateOrder(order.id, { status: 'pendiente_qr', wompi_txn_id: `breb-own-${intent.id}` });
      logger.info({ orderId: order.id, intentId: intent.id, amount: result.amount, bank: result.bank },
        'pago aprobado (breb propio, match por monto)');
      notifySale(getOrder(order.id), 'QR Nequi');
      sendActivationEmail(getOrder(order.id)).catch(() => {});
      try { enqueueWhatsApp(getOrder(order.id), 'activacion'); } catch (e) {
        logger.error({ orderId: order.id, err: e.message }, 'wa: no se pudo encolar activación (breb propio)');
      }
    } catch (e) {
      logger.error({ alias, err: e.message }, 'breb propio: error en el match');
    }
  };

  // Login del panel: usuario + contraseña → devuelve el token Bearer que usan los /admin/*.
  // Comparación en tiempo constante para no filtrar credenciales por timing.
  const safeEq = (a, b) => {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };
  app.post('/admin/login', async (req, reply) => {
    if (!config.hasAdminLogin) return reply.code(503).send({ error: 'admin login no configurado' });
    const { user, pass } = req.body || {};
    if (!user || !pass) return reply.code(400).send({ error: 'faltan usuario o contraseña' });
    if (!safeEq(user, config.ADMIN_USER) || !safeEq(pass, config.ADMIN_PASS)) {
      return reply.code(401).send({ error: 'usuario o contraseña incorrectos' });
    }
    return { token: config.ADMIN_TOKEN };
  });

  // Raíz: respuesta amable (api.sono.lat es la API, no una página). Evita que el 404
  // crudo de Fastify parezca un error si alguien entra a la raíz.
  app.get('/', async () => ({ ok: true, service: 'sono-api', web: 'https://sono.lat' }));

  app.get('/healthz', async () => ({ ok: true, time: new Date().toISOString() }));

  // -------------------------------------------------------------------------
  // Checkout MercadoPago
  // -------------------------------------------------------------------------

  // Precios de lanzamiento en centavos COP (espejo de sono-web/lib/plans.ts):
  // Mismo producto (dispositivo + 1er año de servicio + envío; el aparato queda del
  // cliente), DOS formas de pagar lo que se cobra HOY:
  //   - contado: $199.000 de una.
  //   - cuotas:  $69.000 = 1ª de 3 cuotas ($207.000 total). Las cuotas 2 y 3 se cobran
  //              después: tarjeta tokenizada (automático) o link por WhatsApp (PSE/otros).
  //              Si no paga una cuota, se corta el servicio (enforcement MQTT).
  // La renovación ($99.000/año) NO se cobra acá: va por recordatorio a partir del 2º año.
  // "test" = orden de diagnóstico de /test-mp ($5.000, va directo al Brick de MP).
  // Compat: el viejo "anual" sigue mapeando a $199.000. Cualquier plan desconocido
  // (o ausente) cae a contado vía el ?? de abajo.
  // contado: $199.000 (envío incluido). cuotas: 1ª cuota $69.000 + envío $12.000 = $81.000
  // (el plan en cuotas NO incluye envío gratis). anual = compat viejo → contado.
  const PLAN_PRICES_CENTS = { contado: 19_900_000, cuotas: 8_100_000, anual: 19_900_000, test: 500_000 };
  // Recargo de pago contraentrega (se suma al monto en AMBOS planes).
  const RECARGO_CONTRAENTREGA_CENTS = 500_000;

  // Buscador PÚBLICO de ciudades para el checkout: mismo catálogo DANE que usa el
  // admin al crear envíos (co-dane.js), así la ciudad del cliente queda escrita
  // exactamente como la espera Skydropx. Sin auth: es data pública de DIVIPOLA.
  app.get('/cities', async (req) => {
    const q = String((req.query || {}).q || '').trim();
    return { cities: q.length >= 2 ? searchCities(q, 8) : [] };
  });

  // Convocatoria UGC: recibe una aplicación del formulario público de
  // sonoback.com/convocatoria y la guarda para gestionarla en /admin.
  // Sin auth (público). Honeypot 'botcheck': si viene relleno, se descarta en silencio.
  app.post('/ugc-apply', async (req, reply) => {
    const b = req.body || {};
    if (b.botcheck) return { ok: true };               // bot: aceptar sin guardar
    const s = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const nombre = s(b.nombre, 120);
    const whatsapp = s(b.whatsapp, 40);
    if (!nombre || !whatsapp) {
      return reply.code(400).send({ error: 'nombre y whatsapp son obligatorios' });
    }
    insertUgcApplication({
      nombre,
      whatsapp,
      comuna: s(b.comuna, 120),
      redes: s(b.redes, 300),
      contenido: s(b.contenido, 4000),
      tipo_local: s(b.tipo_local, 120),
      relacion_local: s(b.relacion_local, 120),
      link_local: s(b.link_local, 500),
      celular_graba: s(b.celular_graba, 120),
      disponible_7dias: s(b.disponible_7dias, 60),
      origen: s(b.origen, 200) || 'convocatoria',
      ip: req.ip || null,
    });
    return { ok: true };
  });

  // Paso 1: crea la orden con los datos de envío. Devuelve el monto (pesos) y la public key
  // para que el front renderice el formulario de tarjeta (Bricks) embebido.
  app.post('/checkout/create', async (req, reply) => {
    if (!config.hasEfipay && !config.hasStripe && !config.hasMp) {
      return reply.code(503).send({ error: 'checkout no configurado' });
    }
    const { business_name, bank, address, city, phone, email, plan, delivery, city_dane } = req.body || {};
    if (!business_name || !address || !phone) {
      return reply.code(400).send({ error: 'faltan nombre, direccion o telefono' });
    }
    // Ciudad elegida del autocomplete: si el DANE es válido, la ciudad se guarda con el
    // nombre canónico del catálogo (concuerda 1:1 con el sistema de envíos Skydropx).
    // Si no llegó DANE (texto libre / página vieja cacheada), queda el texto tal cual.
    const ciudadCatalogo = city_dane ? cityByDane(city_dane) : null;
    const planNorm = plan === 'cuotas' ? 'cuotas' : 'contado';
    const esContraentrega = delivery === 'contraentrega';
    const deliveryNorm = esContraentrega ? 'contraentrega' : 'online';
    // El recargo de contraentrega ($5.000) se suma en ambos planes (en cuotas, el
    // cliente paga al recibir la 1ª cuota + envío + recargo = $86.000).
    const amountCents = (PLAN_PRICES_CENTS[plan] ?? PLAN_PRICES_CENTS.contado)
      + (esContraentrega ? RECARGO_CONTRAENTREGA_CENTS : 0);
    const orderId = createOrder({ amountCents });            // external_reference = orderId
    updateOrder(orderId, {
      business_name, bank: bank || null, address, phone,
      city: ciudadCatalogo ? ciudadCatalogo.city : (city || null),
      city_dane: ciudadCatalogo ? ciudadCatalogo.dane : null,
      customer_email: email || null,
      plan: planNorm,
      delivery: deliveryNorm,
      // En cuotas guardamos el total de cuotas desde ya (la 1ª se cobra en este checkout).
      installments_total: planNorm === 'cuotas' ? 3 : 1,
      installments_paid: 0,
    });
    // CONTRAENTREGA: no se cobra online. La orden queda pendiente de confirmación
    // manual (el dueño valida por WhatsApp antes de despachar). Devolvemos la bandera
    // para que el front muestre 'te confirmamos' y NO renderice el formulario de pago.
    if (esContraentrega) {
      updateOrder(orderId, { status: 'cod_pending' });
      logger.info({ orderId, plan: planNorm, amountCents, business_name }, 'orden contraentrega (pendiente de confirmación)');
      try { enqueueWhatsApp(getOrder(orderId), 'activacion'); } catch (e) {
        logger.error({ orderId, err: e.message }, 'wa: no se pudo encolar activación (COD)');
      }
      return { orderId, amount: Math.round(amountCents / 100), contraentrega: true };
    }
    // En 'cuotas' lo cobrado hoy es la 1ª de 3; el cobro de las cuotas 2-3 se hace
    // luego (tarjeta tokenizada o link WhatsApp). Lo dejamos en el log por ahora.
    logger.info({ orderId, plan: plan || 'contado', amountCents, business_name }, 'orden creada');
    // Proveedor de pago: 1º Stripe embebido (dentro de sono.lat; la cuenta MP no
    // procesa por API directa, error 412/9510) → 2º Checkout Pro de MercadoPago
    // (redirect) → 3º Brick in-web (por si MP habilita la API).
    let stripeClientSecret = null;
    let checkoutUrl = null;
    if (plan === 'test') {
      // diagnóstico MP: solo orderId + publicKey, el front monta el Brick directo
      return { orderId, amount: Math.round(amountCents / 100), publicKey: config.MP_PUBLIC_KEY };
    }
    // EfiPay embebido: el front monta su propio formulario de tarjeta y cobra por
    // /checkout/efipay-pay. Acá solo devolvemos orderId + monto (sin proveedor externo).
    if (config.hasEfipay) {
      return { orderId, amount: Math.round(amountCents / 100), provider: 'efipay' };
    }
    if (!checkoutUrl && config.hasStripe) {
      try {
        stripeClientSecret = await createStripeCheckout(orderId, amountCents);
      } catch (e) {
        logger.error({ orderId, err: e.message }, 'stripe checkout failed');
      }
    }
    if (!checkoutUrl && !stripeClientSecret) {
      try {
        checkoutUrl = await createPreference(orderId, amountCents);
      } catch (e) {
        logger.error({ orderId, err: e.message }, 'mp preference failed');
      }
    }
    return {
      orderId,
      amount: Math.round(amountCents / 100),
      publicKey: config.MP_PUBLIC_KEY,
      stripeClientSecret,
      stripePublicKey: stripeClientSecret ? config.STRIPE_PUBLIC_KEY : null,
      checkoutUrl,
    };
  });

  // Paso 2: procesa el pago in-web con el formData del Payment Brick (tarjeta, PSE, Nequi, Efecty…).
  app.post('/checkout/pay', async (req, reply) => {
    if (!config.hasMp) return reply.code(503).send({ error: 'checkout no configurado' });
    const { orderId, ...formData } = req.body || {};
    const order = getOrder(orderId);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (isPaid(order)) return { status: 'approved' };
    if (!formData.payment_method_id || !formData.payer?.email) {
      return reply.code(400).send({ error: 'faltan datos del pago' });
    }
    try {
      // IP real del pagador (Caddy adelante → x-forwarded-for), exigida por PSE.
      const clientIp =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
      const payment = await forwardPayment(orderId, order.amount_cents, formData, clientIp, order);
      if (payment.status === 'approved') {
        // Guardamos email + próxima fecha para el recordatorio de renovación anual.
        const nextCharge = Date.now() + 365 * 24 * 3600 * 1000;
        updateOrder(orderId, {
          status: 'pendiente_qr', wompi_txn_id: String(payment.id),
          mp_payer_email: formData.payer.email, next_charge_at: nextCharge,
        });
        logger.info({ orderId, payment: payment.id }, 'pago aprobado (in-web)');
        notifySale(getOrder(orderId), 'MercadoPago');
      } else {
        logger.info({ orderId, payment: payment.id, st: payment.status_detail }, 'pago en proceso/no aprobado');
      }
      return {
        status: payment.status,
        status_detail: payment.status_detail,
        redirect: paymentRedirectUrl(payment), // PSE → banco, efectivo → cupón
      };
    } catch (e) {
      // diagnóstico: qué mandó el Brick (sin token ni datos de tarjeta)
      logger.error(
        {
          orderId,
          err: e.message,
          pm: formData.payment_method_id,
          tipo: formData.payment_type_id,
          cuotas: formData.installments,
          issuer: formData.issuer_id,
          conToken: Boolean(formData.token),
          idType: formData.payer?.identification?.type,
        },
        'mp payment failed',
      );
      // `detail` = respuesta cruda de MP (sin datos de tarjeta); la usa /test-mp para diagnóstico.
      return reply.code(502).send({
        error: 'No pudimos procesar el pago. Probá de nuevo o con otro método.',
        detail: e.message,
      });
    }
  });

  // Pago EMBEBIDO con EfiPay: el front manda los datos de tarjeta, cobramos por API.
  // ⚠️ Recibe datos PCI (número de tarjeta). NO loguear req.body. El monto se fuerza
  // desde la orden (nunca confiar en el front).
  app.post('/checkout/efipay-pay', async (req, reply) => {
    if (!config.hasEfipay) return reply.code(503).send({ error: 'checkout no configurado' });
    const { orderId, card, payer, browser_information } = req.body || {};
    const order = getOrder(orderId);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (isPaid(order)) return { status: 'approved' };
    if (!card?.number || !card?.cvv || !card?.datetime || !card?.holder) {
      return reply.code(400).send({ error: 'faltan datos de la tarjeta' });
    }
    if (!payer?.email || !payer?.name) {
      return reply.code(400).send({ error: 'faltan datos del pagador' });
    }
    try {
      // Completamos el payer con los datos de envío de la orden (EfiPay exige dirección).
      const fullPayer = {
        name: payer.name,
        email: payer.email,
        city: payer.city || order.city || 'Bogota',
        state: payer.state || order.city || 'Bogota',
        address1: payer.address1 || order.address || 'No informado',
        address2: payer.address2 || order.address || 'No informado',
        zipCode: payer.zipCode || '110111',
      };
      const cardWithPhone = { ...card, phone: card.phone || order.phone };
      const result = await chargeCard(
        orderId, order.amount_cents, cardWithPhone, fullPayer, browser_information || null, 'Sonó · servicio',
      );
      if (result.approved) {
        const nextCharge = Date.now() + 365 * 24 * 3600 * 1000;
        updateOrder(orderId, {
          status: 'pendiente_qr', wompi_txn_id: String(result.transactionId || ''),
          mp_payer_email: payer.email, next_charge_at: nextCharge,
        });
        logger.info({ orderId, txn: result.transactionId }, 'pago aprobado (efipay embebido)');
        notifySale(getOrder(orderId), 'tarjeta');
        // Correo con el link de activación (red de seguridad si cierra la pantalla).
        sendActivationEmail(getOrder(orderId)).catch(() => {});
        try { enqueueWhatsApp(getOrder(orderId), 'activacion'); } catch (e) {
          logger.error({ orderId, err: e.message }, 'wa: no se pudo encolar activación');
        }

        // ── Plan en cuotas: la 1ª cuota ya está cobrada. Tokenizamos la tarjeta para
        //    cobrar las cuotas 2-3 (sin re-pedir la tarjeta) y programamos la 2ª a +30d.
        //    Si la tokenización falla, NO rompemos el pago (ya cobró): queda en mora
        //    'sin_token' para resolver manual (link). El cobro real lo hace el job.
        if (order.plan === 'cuotas') {
          const total = order.installments_total || 3;
          const DAY = 24 * 3600 * 1000;
          try {
            const cardToken = await tokenizeCard(card); // card = { holder, number, datetime, cvv, ... }
            updateOrder(orderId, {
              card_token: cardToken,
              installments_paid: 1,
              installment_next_at: Date.now() + 30 * DAY, // 2ª cuota a 30 días
              installment_fails: 0,
              installments_state: 'al_dia',
            });
            logger.info({ orderId, total }, 'cuotas: tarjeta tokenizada, 2ª cuota programada (+30d)');
          } catch (tokErr) {
            updateOrder(orderId, {
              installments_paid: 1,
              installment_next_at: Date.now() + 30 * DAY,
              installments_state: 'sin_token', // requiere cobro manual por link
            });
            logger.error({ orderId, err: tokErr.message }, 'cuotas: tokenización FALLÓ (1ª cuota igual quedó cobrada)');
          }
        }
      } else {
        logger.info({ orderId, status: result.status }, 'efipay embebido no aprobado');
      }
      return { status: result.status, approved: result.approved, redirect: result.redirect };
    } catch (e) {
      // e.message NO contiene datos de tarjeta (chargeCard solo expone errors/message de EfiPay).
      logger.error({ orderId, err: e.message }, 'efipay embebido failed');
      return reply.code(502).send({
        error: 'No pudimos procesar el pago. Revisá los datos de la tarjeta o probá con otra.',
        detail: e.message,
      });
    }
  });

  // Recursos de EfiPay para los formularios del front (bancos PSE, tipos de id, efectivos).
  // Cacheados 1h en memoria (cambian rara vez). name ∈ pse-banks|pse-id-types|cash|methods.
  const efiResCache = new Map();
  app.get('/checkout/efipay-resources/:name', async (req, reply) => {
    if (!config.hasEfipay) return reply.code(503).send({ error: 'no configurado' });
    const name = req.params.name;
    const hit = efiResCache.get(name);
    if (hit && Date.now() - hit.t < 3600_000) return hit.data;
    try {
      const data = await getResource(name);
      efiResCache.set(name, { data, t: Date.now() });
      return data;
    } catch (e) {
      logger.error({ name, err: e.message }, 'efipay resource failed');
      return reply.code(502).send({ error: 'no pudimos cargar el recurso' });
    }
  });

  // Cobro EfiPay por PSE / Bre-B / efectivo. Devuelve redirect (banco/QR/cupón); el
  // resultado FINAL llega por /webhook/efipay (estos métodos no aprueban al instante).
  app.post('/checkout/efipay-alt', async (req, reply) => {
    if (!config.hasEfipay) return reply.code(503).send({ error: 'checkout no configurado' });
    const { orderId, method, payer, pse, breb_cellphone, cash } = req.body || {};
    const order = getOrder(orderId);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (isPaid(order)) return { status: 'approved', approved: true };
    if (!payer?.email || !payer?.name) return reply.code(400).send({ error: 'faltan datos del pagador' });
    try {
      let result;
      if (method === 'pse') {
        if (!pse?.financialInstitutionCode || pse.financialInstitutionCode === '0') {
          return reply.code(400).send({ error: 'elegí tu banco' });
        }
        result = await chargePse(orderId, order.amount_cents, payer, { ...pse, address: pse.address || order.address });
      } else if (method === 'breb') {
        const cel = breb_cellphone || order.phone;
        if (!cel) return reply.code(400).send({ error: 'falta el celular' });
        result = await chargeBreb(orderId, order.amount_cents, payer, cel);
      } else if (method === 'cash') {
        result = await chargeCash(orderId, order.amount_cents, payer, cash || {});
      } else {
        return reply.code(400).send({ error: 'método inválido' });
      }
      // Guardamos el payment_id de EfiPay SIEMPRE: PSE/Bre-B/cash confirman por webhook,
      // pero si el webhook no llega podemos consultar el estado por API con este id
      // (red de seguridad anti-pagos-atascados, ver GET /activar/:order).
      if (result.paymentId) updateOrder(orderId, { efi_payment_id: String(result.paymentId), mp_payer_email: payer.email });
      // No marcamos pagado acá salvo que ya haya aprobado al instante.
      if (result.approved) {
        const nextCharge = Date.now() + 365 * 24 * 3600 * 1000;
        updateOrder(orderId, {
          status: 'pendiente_qr', wompi_txn_id: String(result.transactionId || ''),
          mp_payer_email: payer.email, next_charge_at: nextCharge,
        });
        notifySale(getOrder(orderId), method === 'pse' ? 'PSE' : method === 'breb' ? 'Bre-B' : 'efectivo');
        sendActivationEmail(getOrder(orderId)).catch(() => {});
        try { enqueueWhatsApp(getOrder(orderId), 'activacion'); } catch (e) {
          logger.error({ orderId, err: e.message }, 'wa: no se pudo encolar activación');
        }
      }
      logger.info({ orderId, method, status: result.status, paymentId: result.paymentId, hasRedirect: Boolean(result.redirect), hasQr: Boolean(result.qr) }, 'efipay alt iniciado');
      // Bre-B con QR → el front lo muestra embebido (no redirige). PSE/cash → redirect.
      return { status: result.status, approved: result.approved, redirect: result.redirect, qr: result.qr || null };
    } catch (e) {
      logger.error({ orderId, method, err: e.message }, 'efipay alt failed');
      return reply.code(502).send({ error: 'No pudimos iniciar el pago. Probá de nuevo.', detail: e.message });
    }
  });

  // ── Checkout Bre-B PROPIO (sin pasarela, sin comisión) ──────────────────────
  // El cliente ve el QR Nequi ESTÁTICO de Sonó + el monto EXACTO a digitar + un
  // contador de 2 min. La confirmación llega por el correo de Nequi a la cuenta
  // de pagos (settleOwnBrebPayment matchea por monto). Reemplaza el Bre-B de
  // EfiPay en el front; el de EfiPay queda solo como fallback si esto está apagado.
  const BREB_INTENT_TTL_MS = 2 * 60 * 1000;
  app.post('/checkout/breb-intent', async (req, reply) => {
    if (!config.hasOwnBreb) return reply.code(503).send({ error: 'checkout Bre-B propio no configurado' });
    const order = getOrder((req.body || {}).orderId);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (isPaid(order)) return { paid: true };
    const amount = Math.round(order.amount_cents / 100);
    const intent = createPaymentIntent({ orderId: order.id, amount, ttlMs: BREB_INTENT_TTL_MS });
    logger.info({ orderId: order.id, intentId: intent.id, amount }, 'breb propio: intent creado');
    return {
      intentId: intent.id,
      amount,
      expiresAt: intent.expires_at,
      // Para el contador del front: ms restantes según el RELOJ DEL SERVER (el del
      // cliente puede estar corrido; con esto el front arma su deadline local).
      remainingMs: Math.max(0, intent.expires_at - Date.now()),
      qrData: config.SONO_BREB_EMVCO,
      key: config.SONO_BREB_KEY || null,
    };
  });

  // Estado del intent (para el contador/polling del front). `paid` también cubre
  // el caso en que la orden quedó paga por otro camino (otro método, admin).
  app.get('/checkout/breb-intent/:id', async (req, reply) => {
    const intent = getPaymentIntent(req.params.id);
    if (!intent) return reply.code(404).send({ error: 'intent no encontrado' });
    const order = getOrder(intent.order_id);
    const paid = intent.status === 'paid' || isPaid(order);
    const remainingMs = Math.max(0, intent.expires_at - Date.now());
    return {
      status: paid ? 'paid' : (remainingMs > 0 ? 'pending' : 'expired'),
      paid, remainingMs, amount: intent.amount,
    };
  });

  // Webhook de MercadoPago: notifica cambios de la suscripción y los cobros recurrentes.
  app.post('/webhook/mp', async (req, reply) => {
    reply.code(200).send({ ok: true }); // responder rápido
    setImmediate(async () => {
      try {
        const paymentId = paymentIdFromWebhook(req);
        if (!paymentId) return;
        const payment = await fetchPayment(paymentId);
        if (!payment) return;
        const order = getOrder(String(payment.external_reference));
        if (order && payment.status === 'approved' && !isPaid(order)) {
          updateOrder(order.id, {
            status: 'pendiente_qr', wompi_txn_id: String(payment.id),
            mp_payer_email: payment.payer?.email || null,
          });
          logger.info({ orderId: order.id, payment: payment.id }, 'pago aprobado (webhook)');
          notifySale(getOrder(order.id), 'MercadoPago');
        }
      } catch (e) {
        logger.error({ err: e.message }, 'mp webhook error');
      }
    });
  });

  // Webhook de EfiPay: notifica el resultado del pago por link. Conciliamos por la
  // referencia (= orderId, que mandamos en advanced_options.references al generar el link).
  app.post('/webhook/efipay', async (req, reply) => {
    if (!isValidEfiWebhook(req)) return reply.code(401).send({ error: 'token invalido' });
    reply.code(200).send({ ok: true }); // responder rápido
    setImmediate(async () => {
      try {
        const { reference, status, transactionId } = parseEfiWebhook(req);
        if (!reference) return;
        const order = getOrder(String(reference));
        if (!order) return;
        const ok = /aprob|approv|exito|success|paid/i.test(String(status || ''));
        if (ok && !isPaid(order)) {
          updateOrder(order.id, { status: 'pendiente_qr', wompi_txn_id: String(transactionId || '') });
          logger.info({ orderId: order.id, txn: transactionId }, 'pago aprobado (efipay webhook)');
          notifySale(getOrder(order.id), 'EfiPay');
          sendActivationEmail(getOrder(order.id)).catch(() => {});
          try { enqueueWhatsApp(getOrder(order.id), 'activacion'); } catch (e) {
            logger.error({ orderId: order.id, err: e.message }, 'wa: no se pudo encolar activación (webhook)');
          }
        } else {
          logger.info({ orderId: order.id, status }, 'efipay webhook (no aprobado)');
        }
      } catch (e) {
        logger.error({ err: e.message }, 'efipay webhook error');
      }
    });
  });

  // Estado de la orden para el wizard
  app.get('/activar/:order', async (req, reply) => {
    let o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    // RED DE SEGURIDAD: si la orden NO está pagada pero tiene un pago EfiPay en curso
    // (PSE/Bre-B/efectivo), consultamos el estado por API. Así, aunque el webhook de
    // EfiPay no llegue, la pantalla "Confirmando tu pago" avanza sola cuando el banco
    // confirma. Esto evita que un cliente que YA pagó quede atascado.
    if (!isPaid(o) && o.efi_payment_id) {
      try {
        const st = await fetchEfiStatus(o.efi_payment_id);
        if (st?.approved) {
          const nextCharge = Date.now() + 365 * 24 * 3600 * 1000;
          updateOrder(o.id, { status: 'pendiente_qr', wompi_txn_id: `efi-status-${o.efi_payment_id}`, next_charge_at: nextCharge });
          logger.info({ orderId: o.id, paymentId: o.efi_payment_id }, 'pago confirmado por polling de estado (webhook no llegó)');
          o = getOrder(o.id);
          notifySale(o, 'EfiPay');
          sendActivationEmail(o).catch(() => {});
          try { enqueueWhatsApp(o, 'activacion'); } catch (e) {
            logger.error({ orderId: o.id, err: e.message }, 'wa: no se pudo encolar activación');
          }
        }
      } catch (e) {
        logger.warn({ orderId: o.id, err: e.message }, 'polling de estado EfiPay falló (se reintenta en el próximo poll)');
      }
    }
    return orderView(o);
  });

  // "Altavoz web" para el demo: devuelve los pagos detectados de la cuenta de esa orden,
  // para que la página /demo los reproduzca por voz. Scopeado por el order id (no adivinable).
  app.get('/demo/last', async (req, reply) => {
    const o = getOrder(req.query.order);
    if (!o || !o.account_id) return { announcements: [] };
    const since = Number(req.query.since) || 0;
    return { announcements: announceLog.recentFor(o.account_id, since) };
  });

  // Verificación al volver de MercadoPago: consulta la suscripción y, si quedó autorizada,
  // marca la orden lista. Red de seguridad por si el webhook no llegó (prueba local, demoras).
  app.post('/activar/:order/verify', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (isPaid(order)) return orderView(order);

    // Stripe embebido: al volver llega ?session_id=...; verificamos la sesión.
    const sessionId = (req.body || {}).session_id;
    if (sessionId) {
      const session = await fetchStripeSession(sessionId);
      if (
        session &&
        String(session.client_reference_id) === String(order.id) &&
        session.payment_status === 'paid'
      ) {
        updateOrder(order.id, {
          status: 'pendiente_qr',
          wompi_txn_id: String(session.payment_intent || session.id),
          mp_payer_email: session.customer_details?.email || null,
        });
        logger.info({ orderId: order.id, session: session.id }, 'pago aprobado (stripe)');
        notifySale(getOrder(order.id), 'Stripe');
      }
      return orderView(getOrder(order.id));
    }

    const paymentId = (req.body || {}).id;
    if (!paymentId) return reply.code(400).send({ error: 'falta id de pago' });

    const payment = await fetchPayment(paymentId);
    if (
      payment &&
      String(payment.external_reference) === String(order.id) &&
      payment.status === 'approved'
    ) {
      updateOrder(order.id, { status: 'pendiente_qr', wompi_txn_id: String(payment.id) });
      logger.info({ orderId: order.id, payment: payment.id }, 'pago aprobado (verify)');
      notifySale(getOrder(order.id), 'MercadoPago');
    }
    return orderView(getOrder(order.id));
  });

  // -------------------------------------------------------------------------
  // Conectar correo: Gmail OAuth
  // -------------------------------------------------------------------------

  app.get('/onboard', async (req, reply) => {
    if (!config.hasOAuth) {
      return reply.code(500).send({ error: 'OAuth no configurado. Faltan GOOGLE_CLIENT_ID/SECRET' });
    }
    // Modo wizard: ?order=REF. Modo legacy: ?client=NAME&speaker=spkr-XXX.
    const clientInternalId = req.query.order || req.query.client || `c-${Date.now()}`;
    const speakerId = req.query.speaker || '';
    const url = buildAuthUrl({ clientInternalId, speakerId });
    return reply.redirect(url);
  });

  app.get('/auth/callback', async (req, reply) => {
    const { code, state, error } = req.query;
    const decoded = decodeURIComponent(state || '');
    const [clientInternalId, speakerId] = decoded.split('|');
    const order = getOrder(clientInternalId);
    const wizard = Boolean(order);
    const backToWizard = (qs) => reply.redirect(`${config.FRONTEND_BASE_URL}/activar?order=${clientInternalId}&${qs}`);

    if (error) {
      return wizard ? backToWizard(`error=${encodeURIComponent(error)}`)
                    : reply.type('text/html').send(`<h1>Error</h1><p>${error}</p>`);
    }
    if (!code) return reply.code(400).send({ error: 'missing code' });

    try {
      const tokens = await exchangeCodeForTokens(code);
      logger.info({ id: clientInternalId, email: tokens.email, scopes: tokens.grantedScopes }, 'tokens received');

      // Reusar account existente si el mismo correo ya estaba conectado
      const existing = getAccountByEmail(tokens.email);
      const accountId = existing ? existing.id : clientInternalId;

      // Google solo devuelve refresh_token en la 1ra autorización. Si no vino y NO había
      // cuenta previa con token guardado, no podemos vigilar el correo -> guiar a revocar.
      const existingHasToken = existing && existing.refreshToken;
      if (!tokens.refreshToken && !existingHasToken) {
        const e = new Error('NO_REFRESH_TOKEN');
        e.code = 'NO_REFRESH_TOKEN';
        throw e;
      }

      // refreshToken null + cuenta existente -> COALESCE conserva el token ya guardado.
      upsertAccount({
        id: accountId, email: tokens.email,
        refreshToken: tokens.refreshToken, speakerId: speakerId || null,
        authType: 'oauth',
      });

      if (config.GMAIL_PUBSUB_TOPIC) {
        try {
          const watchRes = await watchInbox(tokens.refreshToken);
          updateAccountHistory(accountId, watchRes.historyId);
          updateAccountWatch(accountId, watchRes.expiration);
        } catch (e) { logger.error({ err: e.message }, 'watchInbox failed'); }
      }

      if (wizard) linkOrderToAccount(order, accountId, 'gmail');
      if (onAccountAdded) await onAccountAdded(accountId);

      if (wizard) return backToWizard('connected=1');
      return reply.type('text/html').send(`<!DOCTYPE html>
<html><body style="font-family: system-ui; max-width: 720px; margin: 4em auto; padding: 1em; line-height: 1.6">
  <h1 style="color: #0a0">Cuenta conectada</h1>
  <p>Gracias <strong>${tokens.email}</strong>! Ya estoy escuchando tus correos.</p>
</body></html>`);
    } catch (e) {
      logger.error({ err: e.message }, 'callback failed');
      const kind = e.message.startsWith('SCOPE_MISSING') ? 'scope'
                 : e.message.startsWith('NO_REFRESH_TOKEN') ? 'norefresh' : 'unknown';
      if (wizard) return backToWizard(`error=${kind}`);

      let title = 'Error', body = `<pre>${e.message}</pre>`;
      if (kind === 'scope') {
        title = 'Falto tildar el checkbox';
        body = `<p>En la pantalla de Google necesitabas <b>tildar el checkbox</b> de Gmail antes de continuar.
                Revoca el acceso en <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> y reintenta.</p>`;
      } else if (kind === 'norefresh') {
        title = 'Faltan permisos';
        body = `<p>Revoca el acceso en <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> y volve a conectar.</p>`;
      }
      return reply.code(400).type('text/html').send(`<!DOCTYPE html>
<html><body style="font-family: system-ui; max-width: 720px; margin: 4em auto; padding: 1em; line-height: 1.6">
  <h1 style="color: #c00">${title}</h1>${body}</body></html>`);
    }
  });

  // -------------------------------------------------------------------------
  // Conectar correo: Microsoft OAuth (Outlook/Hotmail/Live/Office365)
  // -------------------------------------------------------------------------

  app.get('/onboard/microsoft', async (req, reply) => {
    if (!config.hasMsOAuth) {
      return reply.code(500).send({ error: 'Microsoft OAuth no configurado. Faltan MICROSOFT_CLIENT_ID/SECRET' });
    }
    const clientInternalId = req.query.order || req.query.client || `c-${Date.now()}`;
    return reply.redirect(msBuildAuthUrl({ clientInternalId, speakerId: req.query.speaker || '' }));
  });

  app.get('/auth/microsoft/callback', async (req, reply) => {
    const { code, state, error } = req.query;
    const decoded = decodeURIComponent(state || '');
    const [clientInternalId, speakerId] = decoded.split('|');
    const order = getOrder(clientInternalId);
    const wizard = Boolean(order);
    const backToWizard = (qs) => reply.redirect(`${config.FRONTEND_BASE_URL}/activar?order=${clientInternalId}&${qs}`);

    if (error) {
      return wizard ? backToWizard(`error=${encodeURIComponent(error)}`)
                    : reply.type('text/html').send(`<h1>Error</h1><p>${error}</p>`);
    }
    if (!code) return reply.code(400).send({ error: 'missing code' });

    try {
      const tokens = await msExchangeCodeForTokens(code);
      logger.info({ id: clientInternalId, email: tokens.email, provider: 'microsoft' }, 'MS tokens received');

      const existing = getAccountByEmail(tokens.email);
      const accountId = existing ? existing.id : clientInternalId;

      upsertAccount({
        id: accountId, email: tokens.email,
        refreshToken: tokens.refreshToken, speakerId: speakerId || null,
        authType: 'oauth', provider: 'microsoft',
      });

      if (wizard) linkOrderToAccount(order, accountId, 'outlook');
      if (onAccountAdded) await onAccountAdded(accountId);

      if (wizard) return backToWizard('connected=1');
      return reply.type('text/html').send(`<h1 style="color:#0a0;font-family:system-ui">Cuenta conectada</h1><p>${tokens.email}</p>`);
    } catch (e) {
      logger.error({ err: e.message }, 'MS callback failed');
      const kind = e.message.startsWith('SCOPE_MISSING') ? 'scope'
                 : e.message.startsWith('NO_REFRESH_TOKEN') ? 'norefresh' : 'unknown';
      if (wizard) return backToWizard(`error=${kind}`);
      return reply.code(400).type('text/html').send(`<h1 style="color:#c00;font-family:system-ui">Error</h1><pre>${e.message}</pre>`);
    }
  });

  // -------------------------------------------------------------------------
  // Conectar correo: IMAP manual (no-Gmail)
  // -------------------------------------------------------------------------

  app.post('/activar/:order/email-imap', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!canOnboard(order)) return reply.code(402).send({ error: 'orden no pagada' });

    const { host, port, user, pass } = req.body || {};
    if (!host || !user || !pass) return reply.code(400).send({ error: 'faltan host/user/pass' });
    const portNum = Number(port) || 993;

    // Validar credenciales con una conexion IMAP real antes de guardar
    const client = new ImapFlow({
      host, port: portNum, secure: true, auth: { user, pass },
      logger: false,
    });
    try {
      await client.connect();
      await client.mailboxOpen('INBOX', { readOnly: true });
      await client.logout();
    } catch (e) {
      try { await client.close(); } catch {}
      logger.warn({ orderId: order.id, err: e.message }, 'imap test failed');
      return reply.code(400).send({ error: 'No pudimos conectar al correo. Revisa host, usuario y la contraseña de aplicación.' });
    }

    const existing = getAccountByEmail(user);
    const accountId = existing ? existing.id : order.id;
    upsertAccount({
      id: accountId, email: user, authType: 'imap',
      imapHost: host, imapPort: portNum, imapUser: user, imapPass: pass,
    });
    linkOrderToAccount(order, accountId, 'imap');
    if (onAccountAdded) await onAccountAdded(accountId);
    logger.info({ orderId: order.id, email: user }, 'imap account conectada');
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Método "Redirigir mi banco" (correo redirigido a un alias @sono.lat)
  // -------------------------------------------------------------------------

  // El cliente da el correo a donde quiere recibir copia de sus avisos. Generamos su
  // alias <name>@sono.lat y lo CREAMOS en ForwardEmail con recipients = [su correo, webhook].
  // ForwardEmail reenvía el original del banco a su correo Y avisa al webhook (speaker),
  // sin que el cliente tenga que verificar nada. Devolvemos el alias para que lo ponga en su banco.
  app.post('/activar/:order/email-redirect', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!canOnboard(order)) return reply.code(402).send({ error: 'orden no pagada' });

    const body = req.body || {};
    const forwardTo = String(body.email || '').trim().toLowerCase();
    if (!forwardTo || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(forwardTo)) {
      return reply.code(400).send({ error: 'Pon un correo válido.' });
    }
    // associate: la elección del cliente cuando el correo ya existía (true = mismo negocio,
    // otro local; false = cuenta nueva separada). undefined = aún no preguntado.
    const associate = body.associate;

    const accountId = order.account_id || order.id;

    // MULTIPUNTO: ¿este correo ya está en otra cuenta? (otro local del mismo negocio)
    const existing = findAccountByForward(forwardTo, accountId);
    if (existing && associate === undefined) {
      // Aún no preguntamos: el front debe mostrar "¿es otro local del mismo negocio?".
      return {
        ok: false,
        needsAssociationChoice: true,
        existingAlias: existing.email,                 // alias de Sonó ya en uso
        existingBusinessName: existing.business_name || null,
      };
    }

    // Si el cliente dijo "sí, mismo negocio" y existe → REUSAR el alias/cuenta existente.
    if (existing && associate === true) {
      const reAlias = existing.alias || existing.email.split('@')[0];
      // El alias en ForwardEmail ya existe (lo creó la 1ª orden); no lo recreamos.
      // Vinculamos ESTA orden a la cuenta existente; el ruteo por llave separa los locales.
      linkOrderToAccount(order, existing.id, 'redirect');
      logger.info({ orderId: order.id, accountId: existing.id, alias: existing.email }, 'multipunto: orden asociada a cuenta existente (mismo correo)');
      return {
        ok: true,
        alias: existing.email,
        forwardTo,
        associated: true,
        needsVerification: false,
        // Reloj del servidor al registrar el correo: el front lo usa como corte de
        // frescura del OTP (solo mostrar códigos capturados DESPUÉS de este momento).
        now: Date.now(),
      };
    }

    // IDEMPOTENCIA: si ESTA orden ya generó un alias antes (el cliente reentró al paso,
    // recargó, o reintentó), REUSARLO. Sin esto, generateAlias() devolvía un sufijo
    // aleatorio nuevo cada vez y upsertAccount pisaba el anterior → el alias que el
    // cliente ya había puesto en su banco quedaba huérfano (bug: a21a→b559→014f).
    const self = getAccount(accountId);
    if (self && self.alias && self.forwardTo === forwardTo) {
      linkOrderToAccount(order, accountId, 'redirect');
      logger.info({ orderId: order.id, alias: self.alias }, 'email-redirect: alias ya existente reusado (idempotente)');
      return {
        ok: true,
        alias: `${self.alias}@${config.MAIL_DOMAIN}`,
        forwardTo,
        needsVerification: false,
        now: Date.now(),
      };
    }

    // ALIAS INMUTABLE: la orden ya tiene alias pero el cliente escribió OTRO correo
    // personal (typo la 1ª vez, o lo cambió). NO se genera alias nuevo — el alias que
    // el banco ya puede tener configurado se conserva — y solo se actualiza el destino
    // del reenvío (la copia que le llega al cliente; los pagos entran por el MX propio
    // y no dependen de esto).
    if (self && self.alias) {
      const feUp = await updateClientAliasRecipients(self.alias, forwardTo);
      if (!feUp.ok && !feUp.skipped) {
        logger.warn({ orderId: order.id, alias: self.alias, err: feUp.error }, 'email-redirect: no se pudo actualizar destino en FE (se continúa)');
      }
      setAccountForward(accountId, { alias: self.alias, forwardTo });
      linkOrderToAccount(order, accountId, 'redirect');
      logger.info({ orderId: order.id, alias: self.alias, forwardTo }, 'email-redirect: alias conservado, destino actualizado');
      return {
        ok: true,
        alias: `${self.alias}@${config.MAIL_DOMAIN}`,
        forwardTo,
        needsVerification: false,
        now: Date.now(),
      };
    }

    // Flujo normal (correo nuevo, o el cliente eligió cuenta separada): alias nuevo.
    const alias = generateAlias(forwardTo);

    // Crear el alias en ForwardEmail (recipients = correo del cliente + webhook del speaker).
    const fe = await createClientAlias({ name: alias, forwardTo });
    if (!fe.ok && !fe.skipped) {
      logger.error({ orderId: order.id, alias, err: fe.error }, 'email-redirect: fallo crear alias FE');
      return reply.code(502).send({ error: 'No pudimos generar tu correo. Prueba de nuevo.' });
    }

    // Guardar la cuenta (sin watcher; el ingreso es por webhook).
    upsertAccount({ id: accountId, email: `${alias}@${config.MAIL_DOMAIN}`, authType: 'imap', provider: 'redirect' });
    setAccountForward(accountId, { alias, forwardTo });
    linkOrderToAccount(order, accountId, 'redirect');

    logger.info({ orderId: order.id, alias, fe: fe.skipped ? 'skipped(catch-all)' : 'created' }, 'email-redirect onboard');
    return {
      ok: true,
      alias: `${alias}@${config.MAIL_DOMAIN}`,
      forwardTo,
      // ForwardEmail NO requiere verificación del destino → el cliente puede ir directo al banco.
      needsVerification: false,
      now: Date.now(),
    };
  });

  // Endpoint legacy de status (Cloudflare). Con ForwardEmail no hay verificación → siempre "verified".
  app.get('/activar/:order/email-redirect/status', async (req, reply) => {
    // ForwardEmail no requiere verificación del destino → siempre listo.
    return { verified: true, skipped: true };
  });

  // -------------------------------------------------------------------------
  // Subir QR + datos de envio
  // -------------------------------------------------------------------------

  // Guarda el archivo del QR, marca ready_to_ship y decodifica la llave Bre-B para el
  // ruteo multipunto. Lo usan el cliente (/activar/:order/qr) y el admin (subida manual).
  // Devuelve { hasQr, brebKey, brebKeyType, qrReadable } — brebKey=null si no se pudo
  // decodificar. Con opts.requireReadableQr, si la imagen NO tiene un QR de Bre-B legible
  // devuelve { rejected } SIN guardar (para no pisar un QR bueno previo), con rejected:
  //   - 'no_qr'    → la foto no tiene ningún QR legible (movida/borrosa).
  //   - 'not_breb' → se leyó un QR pero NO es de Bre-B (otro QR, un link, etc.).
  // El cliente debe repetir. El admin NO pasa la opción → puede forzar cualquier imagen.
  async function processQrUpload(order, buf, mimetype, ext, opts = {}) {
    const isImage = mimetype.startsWith('image/');

    // Multipunto: escanear el QR ANTES de guardar. Separa "no se leyó ningún QR"
    // (foto mala) de "se leyó un QR pero no es Bre-B" (otro QR) de "es Bre-B".
    let scan = { qrText: null, decoded: null, isBreb: false };
    if (isImage) {
      try {
        scan = await scanBrebImage(buf);
      } catch (e) {
        logger.warn({ orderId: order.id, err: e.message }, 'multipunto: fallo al leer el QR');
      }
    }
    // Validación para el cliente (rechaza sin tocar el QR ya guardado):
    if (opts.requireReadableQr && isImage) {
      if (!scan.qrText) return { rejected: 'no_qr', hasQr: false };
      if (!scan.isBreb) return { rejected: 'not_breb', hasQr: false };
    }

    const filename = `${order.id}.${ext}`;
    fs.writeFileSync(path.join(QR_DIR, filename), buf);

    const patch = { qr_path: filename, qr_mime: mimetype };
    if (order.business_name) patch.status = 'ready_to_ship';
    updateOrder(order.id, patch);

    // Venta COD: cuenta cuando sube el QR por primera vez (igual que Meta CAPI),
    // no al crear la orden. Las online avisan al pagar, no acá.
    if (order.delivery === 'contraentrega' && !order.qr_path) {
      notifySale(getOrder(order.id), 'contraentrega');
    }

    // El cliente ya tiene su QR: los WhatsApp de onboarding pendientes ("sube tu QR")
    // quedan obsoletos — en ESTA orden y en cualquier orden HERMANA del mismo teléfono
    // (checkout reintentado deja duplicadas sin QR que seguían recordando; bug 16-jul).
    try {
      const KINDS = ['activacion', 'recordatorio_3h', 'recordatorio_24h'];
      let n = cancelPendingWaByKinds(order.id, KINDS);
      const ph = normalizePhoneCO(order.phone);
      if (ph) {
        for (const sib of listOrders()) {
          if (sib.id !== order.id && normalizePhoneCO(sib.phone) === ph) {
            n += cancelPendingWaByKinds(sib.id, KINDS);
          }
        }
      }
      if (n) logger.info({ orderId: order.id, n }, 'wa: onboarding pendiente cancelado (QR ya subido, incluye órdenes hermanas)');
    } catch (e) {
      logger.warn({ orderId: order.id, err: e.message }, 'wa: no se pudo cancelar el onboarding pendiente');
    }

    let brebKey = null, brebKeyType = null;
    // Multipunto: usar la llave Bre-B ya extraída del escaneo para guardarla en el device
    // de esta orden (sirve para rutear los pagos al speaker correcto). Solo imágenes (los
    // PDF no se decodifican acá). Si no hay llave, NO rompemos la subida del QR.
    const decoded = scan.decoded;
    if (decoded && decoded.routable && decoded.key) {
      brebKey = normalizeKey(decoded.key);
      brebKeyType = decoded.keyType;
      const dev = listDevices().find((d) => d.order_id === order.id);
      if (dev) {
        setDeviceBrebKey(dev.spkr_id, {
          key: brebKey,
          qrJson: { raw: decoded.raw, key: decoded.key, keyType: decoded.keyType },
          localName: decoded.merchantName || order.business_name || null,
        });
        logger.info({ orderId: order.id, spkr: dev.spkr_id, key: decoded.key, keyType: decoded.keyType }, 'multipunto: llave Bre-B asociada al device');
      } else {
        // El device aún no está asignado: guardamos la llave en la orden para
        // transferirla al device cuando se asigne el speaker (al despachar).
        updateOrder(order.id, {
          breb_key: brebKey,
          breb_qr_json: JSON.stringify({ raw: decoded.raw, key: decoded.key, keyType: decoded.keyType }),
          local_name: decoded.merchantName || order.business_name || null,
        });
        logger.info({ orderId: order.id, key: decoded.key }, 'multipunto: llave detectada, device aún sin asignar (se asociará al asignar el speaker)');
      }
    } else if (isImage) {
      logger.warn({ orderId: order.id, qrRead: Boolean(scan.qrText) }, 'multipunto: QR sin llave ruteable (no se pudo asociar)');
    }
    return { hasQr: true, brebKey, brebKeyType, qrReadable: isImage ? Boolean(scan.qrText) : null };
  }

  app.post('/activar/:order/qr', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!canOnboard(order)) return reply.code(402).send({ error: 'orden no pagada' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    const ext = MIME_EXT[file.mimetype];
    if (!ext) return reply.code(415).send({ error: 'formato no soportado (usa png/jpg/webp/pdf)' });

    const buf = await file.toBuffer();
    if (buf.length > 5 * 1024 * 1024) return reply.code(413).send({ error: 'archivo muy grande' });

    // Exigir un QR de Bre-B legible: si la foto está movida (no se lee QR) o el QR no es
    // de Bre-B (otro QR/link), se rechaza para que el cliente lo corrija (no se guarda nada).
    const res = await processQrUpload(order, buf, file.mimetype, ext, { requireReadableQr: true });
    if (res.rejected === 'no_qr') {
      logger.info({ orderId: order.id, bytes: buf.length }, 'qr rechazado: foto sin QR legible');
      return reply.code(422).send({
        error: 'No pudimos leer el QR de la foto. Tomala otra vez bien enfocada, derecha y con buena luz, que se vea el QR completo y sin reflejos.',
      });
    }
    if (res.rejected === 'not_breb') {
      logger.info({ orderId: order.id, bytes: buf.length }, 'qr rechazado: no es un QR de Bre-B');
      return reply.code(422).send({
        error: 'Ese no es un QR de Bre-B. Sube el QR de Bre-B que generás desde la app de tu banco (Bancolombia, Nequi o BBVA), no otro QR.',
      });
    }
    logger.info({ orderId: order.id, bytes: buf.length }, 'qr subido');
    return { ok: true };
  });

  app.post('/activar/:order/shipping', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!canOnboard(order)) return reply.code(402).send({ error: 'orden no pagada' });

    const { business_name, bank, address, city, phone } = req.body || {};
    if (!business_name || !address || !phone) {
      return reply.code(400).send({ error: 'faltan negocio, direccion o telefono' });
    }
    const patch = { business_name, bank: bank || null, address, city: city || null, phone };
    // No se despacha sin QR: solo pasa a ready_to_ship si ya hay QR
    if (order.qr_path) patch.status = 'ready_to_ship';
    updateOrder(order.id, patch);
    logger.info({ orderId: order.id, business_name }, 'envio guardado');
    return { ok: true, status: patch.status || order.status };
  });

  // -------------------------------------------------------------------------
  // Admin (fulfillment / inventario)
  // -------------------------------------------------------------------------

  // Por defecto NO devuelve las archivadas (soft-delete). Con ?archived=1 devuelve
  // SOLO las archivadas (para la vista "Archivados" del panel).
  app.get('/admin/orders', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const onlyArchived = req.query.archived === '1' || req.query.archived === 'true';
    const byOrder = new Map(listDevices().filter(d => d.order_id).map(d => [d.order_id, d.spkr_id]));
    return listOrders()
      .filter(o => onlyArchived ? Boolean(o.archived_at) : !o.archived_at)
      .map(o => ({
        id: o.id, status: o.status, business_name: o.business_name, bank: o.bank,
        address: o.address, city: o.city, phone: o.phone, email_method: o.email_method,
        account_id: o.account_id, hasQr: Boolean(o.qr_path), created_at: o.created_at,
        next_charge_at: o.next_charge_at, mp_payer_email: o.mp_payer_email,
        amount_cents: o.amount_cents, breb_key: o.breb_key, customer_email: o.customer_email,
        archived_at: o.archived_at || null,
        speaker_id: byOrder.get(o.id) || null,
      }));
  });

  // Archivar (soft-delete): la orden sale del panel pero queda en la DB. Guarda el
  // estado previo para poder restaurarla. Idempotente (si ya está archivada, no hace nada).
  app.post('/admin/orders/:order/archive', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    if (o.archived_at) return { ok: true, archived: true }; // ya archivada
    updateOrder(o.id, { prev_status: o.status, status: 'archivada', archived_at: Date.now() });
    // Una orden archivada no le manda NADA al cliente: matar sus WhatsApps en cola.
    const nCanceled = cancelAllPendingWa(o.id);
    if (nCanceled) logger.info({ orderId: o.id, n: nCanceled }, 'wa: mensajes pendientes cancelados al archivar');
    logger.info({ orderId: o.id, business: o.business_name, prevStatus: o.status }, 'orden archivada (soft-delete)');
    return { ok: true, archived: true };
  });

  // Restaurar una orden archivada a su estado previo.
  app.post('/admin/orders/:order/unarchive', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!o.archived_at) return { ok: true, archived: false }; // no estaba archivada
    updateOrder(o.id, { status: o.prev_status || 'created', archived_at: null, prev_status: null });
    logger.info({ orderId: o.id, business: o.business_name, restoredTo: o.prev_status || 'created' }, 'orden restaurada');
    return { ok: true, archived: false };
  });

  // Crear una orden MANUAL (venta offline): se crea ya PAGADA (cobrás aparte en
  // efectivo/transferencia) y se devuelve el link de onboarding para pasárselo al
  // cliente. Renovación anual desde hoy.
  app.post('/admin/orders/manual', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { business_name, bank, address, city, phone, payer_email } = req.body || {};
    if (!business_name) return reply.code(400).send({ error: 'falta el nombre del negocio' });
    const orderId = createOrder({ amountCents: PLAN_PRICES_CENTS.anual });
    const nextCharge = Date.now() + 365 * 24 * 3600 * 1000; // anual
    updateOrder(orderId, {
      business_name,
      bank: bank || null,
      address: address || null,
      city: city || null,
      phone: phone || null,
      mp_payer_email: payer_email || null,
      status: 'pendiente_qr',      // pagada → entra directo al onboarding (correo + QR + envío)
      next_charge_at: nextCharge,
    });
    const link = `${config.FRONTEND_BASE_URL}/activar-pro?order=${orderId}`;
    logger.info({ orderId, business_name }, 'orden manual creada (venta offline)');
    return { ok: true, orderId, link, next_charge_at: nextCharge };
  });

  // Prueba del push de venta (cha-ching): manda la notificación de una venta falsa
  // a los dispositivos suscritos, sin tocar órdenes reales.
  app.post('/admin/test-venta', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    notifySale({ id: `test-${Date.now()}`, amount_cents: 19_900_000, business_name: 'Venta de prueba' }, 'test');
    return { ok: true };
  });

  app.get('/admin/orders/:order/qr', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o || !o.qr_path) return reply.code(404).send({ error: 'sin QR' });
    const fp = path.join(QR_DIR, o.qr_path);
    if (!fs.existsSync(fp)) return reply.code(404).send({ error: 'archivo no encontrado' });
    reply.header('Content-Type', o.qr_mime || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${o.qr_path}"`);
    return reply.send(fs.readFileSync(fp));
  });

  // Devuelve el EMVCo (string crudo) del QR de la orden, para imprimirlo en la térmica
  // con el diseño Sonó (el agente local arma la etiqueta). Lo saca del breb_qr_json
  // guardado (device u orden); si no está (órdenes viejas), decodifica el archivo del QR.
  app.get('/admin/orders/:order/breb', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });

    // 1. de lo ya decodificado y guardado (device tiene prioridad, luego la orden)
    const dev = listDevices().find((d) => d.order_id === o.id);
    const stored = (dev && dev.breb_qr_json) || o.breb_qr_json || null;
    if (stored) {
      try {
        const j = typeof stored === 'string' ? JSON.parse(stored) : stored;
        if (j && j.raw) return { raw: j.raw, key: j.key || o.breb_key || null, keyType: j.keyType || null };
      } catch { /* sigue al fallback */ }
    }

    // 2. fallback: decodificar el archivo del QR (para órdenes subidas antes del fix)
    if (o.qr_path && (o.qr_mime || '').startsWith('image/')) {
      const fp = path.join(QR_DIR, o.qr_path);
      if (fs.existsSync(fp)) {
        try {
          const decoded = await decodeBrebImage(fs.readFileSync(fp));
          if (decoded && decoded.raw) {
            return { raw: decoded.raw, key: normalizeKey(decoded.key), keyType: decoded.keyType };
          }
        } catch (e) {
          logger.warn({ orderId: o.id, err: e.message }, 'breb: no se pudo decodificar el archivo del QR');
        }
      }
    }
    return reply.code(404).send({ error: 'no hay QR decodificable en esta orden' });
  });

  // Quitar el QR de una orden (p.ej. el admin lo subió a la orden equivocada). Borra el
  // archivo, limpia la llave Bre-B (orden + device si la tenía) y revierte el estado a
  // pendiente_qr para que se pueda volver a subir el correcto.
  app.delete('/admin/orders/:order/qr', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!o.qr_path) return reply.code(404).send({ error: 'la orden no tiene QR' });

    // borrar el archivo físico (si existe)
    try {
      const fp = path.join(QR_DIR, o.qr_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) {
      logger.warn({ orderId: o.id, err: e.message }, 'no se pudo borrar el archivo del QR (sigo limpiando la DB)');
    }

    // limpiar la llave del device asignado (si la subida la había guardado ahí)
    const dev = listDevices().find((d) => d.order_id === o.id);
    if (dev && dev.breb_key) {
      setDeviceBrebKey(dev.spkr_id, { key: null, qrJson: null, localName: null });
    }

    // limpiar la orden y revertir estado. Si estaba ready_to_ship por tener QR, vuelve a
    // pendiente_qr; si ya iba más adelante (shipped) no lo tocamos.
    const patch = { qr_path: null, qr_mime: null, breb_key: null, breb_qr_json: null, local_name: null };
    if (o.status === 'ready_to_ship') patch.status = 'pendiente_qr';
    updateOrder(o.id, patch);
    logger.info({ orderId: o.id }, 'qr eliminado por admin');
    return { ok: true };
  });

  // El admin sube el QR del cliente MANUALMENTE (cuando el cliente lo manda por WhatsApp
  // en vez de subirlo él mismo en /activar). Mismo flujo que el del cliente: guarda el
  // archivo, marca ready_to_ship y decodifica la llave Bre-B para el ruteo multipunto.
  app.post('/admin/orders/:order/qr', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    const ext = MIME_EXT[file.mimetype];
    if (!ext) return reply.code(415).send({ error: 'formato no soportado (usa png/jpg/webp/pdf)' });

    const buf = await file.toBuffer();
    if (buf.length > 5 * 1024 * 1024) return reply.code(413).send({ error: 'archivo muy grande' });

    const result = await processQrUpload(order, buf, file.mimetype, ext);
    logger.info({ orderId: order.id, bytes: buf.length, admin: true, brebKey: result.brebKey }, 'qr subido por admin');
    return { ok: true, ...result };
  });

  // Detalle completo de un pedido para el drawer del admin: datos del pedido +
  // cuenta (correo/alias/forward/speaker) + pagos detectados + estado de suscripción.
  app.get('/admin/orders/:order/detail', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    const dev = listDevices().find(d => d.order_id === o.id) || null;
    const acc = o.account_id ? getAccount(o.account_id) : null;
    // Pagos persistidos (DB) + los del buffer en memoria que aún no estén; dedup por timestamp.
    const persisted = o.account_id ? paymentsFor(o.account_id, 50) : [];
    const seen = new Set(persisted.map(p => p.at));
    const memOnly = o.account_id
      ? announceLog.recentFor(o.account_id, 0).filter(p => !seen.has(p.at))
        .map(p => ({ id: null, amount: p.amount, bank: p.bank, payer: null, at: p.at }))
      : [];
    const payments = [...persisted, ...memOnly].sort((a, b) => b.at - a.at).slice(0, 50);
    return {
      id: o.id,
      status: o.status,
      created_at: o.created_at,
      // envío
      business_name: o.business_name, bank: o.bank, address: o.address, city: o.city, phone: o.phone,
      // DANE de la ciudad del autocomplete del checkout: el admin preselecciona la
      // ciudad canónica al cotizar el envío (sin elegir entre homónimas).
      city_dane: o.city_dane || null,
      // pago / suscripción
      payer_email: o.mp_payer_email || null,
      next_charge_at: o.next_charge_at || null,
      amount_cents: o.amount_cents || null,
      // correo
      email_method: o.email_method || null,
      account_id: o.account_id || null,
      email: acc ? acc.email : null,
      alias: acc && acc.alias ? `${acc.alias}@${config.MAIL_DOMAIN}` : null,
      forward_to: acc ? (acc.forwardTo || null) : null,
      change_confirmed: acc ? Boolean(acc.change_confirmed) : false,
      // speaker
      speaker_id: dev ? dev.spkr_id : null,
      device: dev ? { spkr_id: dev.spkr_id, mac: dev.mac, model: dev.model, status: dev.status } : null,
      // entrega: 'online' (prepago) | 'contraentrega' (paga al recibir → COD en el envío)
      delivery: o.delivery || 'online',
      // plan elegido: 'contado' | 'cuotas' (para mostrarlo en el admin)
      plan: o.plan || null,
      // llave Bre-B vigente del local (la del device asignado; la de la orden es respaldo)
      breb_key: (dev && dev.breb_key) || o.breb_key || null,
      // QR
      hasQr: Boolean(o.qr_path),
      qr_mime: o.qr_mime || null,
      // link de onboarding para pasarle al cliente (venta offline / reenvío)
      activation_link: `${config.FRONTEND_BASE_URL}/activar-pro?order=${o.id}`,
      // pagos
      payments,
    };
  });

  // Editar los datos de envío de un pedido desde el admin (corregir errores del cliente).
  app.patch('/admin/orders/:order', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    const { business_name, bank, address, city, phone } = req.body || {};
    const patch = {};
    if (business_name !== undefined) patch.business_name = business_name || null;
    if (bank !== undefined) patch.bank = bank || null;
    if (address !== undefined) patch.address = address || null;
    if (city !== undefined) patch.city = city || null;
    if (phone !== undefined) patch.phone = phone || null;
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nada para actualizar' });
    updateOrder(o.id, patch);
    logger.info({ orderId: o.id, fields: Object.keys(patch) }, 'envio editado (admin)');
    return { ok: true };
  });

  app.post('/admin/orders/:order/device', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });

    const { spkr_id } = req.body || {};
    const dev = getDevice(spkr_id);
    if (!dev) return reply.code(404).send({ error: 'device no registrado' });
    if (dev.status === 'asignado' && dev.order_id !== o.id) {
      return reply.code(409).send({ error: 'device ya asignado a otra orden' });
    }
    // Asignar a la ORDEN siempre (se puede hacer ANTES de que el cliente conecte correo).
    assignDevice(spkr_id, o.id);
    // Si la cuenta ya existe, vincular ya; si no, se hereda al conectar el correo.
    if (o.account_id) setAccountSpeaker(o.account_id, spkr_id);
    // Multipunto: si la orden ya tenía la llave Bre-B (del QR subido antes de asignar el
    // device), la transferimos al device ahora para que pueda rutear pagos.
    if (o.breb_key) {
      setDeviceBrebKey(spkr_id, {
        key: o.breb_key,
        qrJson: o.breb_qr_json ? JSON.parse(o.breb_qr_json) : null,
        localName: o.local_name || o.business_name || null,
      });
      logger.info({ orderId: o.id, spkr_id, key: o.breb_key }, 'multipunto: llave Bre-B transferida de la orden al device');
    }
    logger.info({ orderId: o.id, spkr_id, account: o.account_id || '(pendiente)' }, 'device asignado a la orden');
    return { ok: true, spkr_id, account_id: o.account_id || null };
  });

  // Vincular / editar / borrar MANUALMENTE la llave Bre-B de un local desde el admin.
  // key vacío o null → borrar. Se guarda en el device asignado (lo que rutea) Y en la
  // orden (respaldo que se transfiere si se reasigna speaker). qrJson va null: es un
  // vínculo manual, sin QR decodificado.
  app.post('/admin/orders/:order/breb-key', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    const body = req.body || {};
    const key = body.key ? normalizeKey(String(body.key)) : null;
    const name = key
      ? (body.localName !== undefined ? (body.localName || null) : (o.local_name || o.business_name || null))
      : null;
    const dev = listDevices().find((d) => d.order_id === o.id);
    if (dev) setDeviceBrebKey(dev.spkr_id, { key, qrJson: null, localName: name });
    updateOrder(o.id, { breb_key: key, breb_qr_json: null, local_name: name });
    logger.info({ orderId: o.id, spkr: dev ? dev.spkr_id : null, key }, key ? 'admin: llave Bre-B vinculada/editada manualmente' : 'admin: llave Bre-B borrada');
    return { ok: true, key, spkr_id: dev ? dev.spkr_id : null };
  });

  // Desasignar un device de una orden (devolución / reasignar).
  app.post('/admin/orders/:order/unassign', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    const dev = listDevices().find((d) => d.order_id === o.id);
    if (dev) unassignDevice(dev.spkr_id);
    if (o.account_id) setAccountSpeaker(o.account_id, null);
    logger.info({ orderId: o.id, spkr_id: dev?.spkr_id }, 'device desasignado');
    return { ok: true };
  });

  // Marcar una orden como enviada (y su device como enviado).
  app.post('/admin/orders/:order/shipped', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    updateOrder(o.id, { status: 'shipped' });
    const dev = listDevices().find(d => d.order_id === o.id);
    if (dev) setDeviceStatus(dev.spkr_id, 'enviado');
    logger.info({ orderId: o.id }, 'orden enviada');
    return { ok: true };
  });

  // Cambiar manualmente el estado de una orden a CUALQUIER estado (selector del
  // drawer del admin, jul-2026). Incluye 'cancelada'. Solo sincroniza el device en
  // los estados de despacho; cancelar NO desasigna el speaker (eso va aparte, con
  // /unassign, para no soltar un speaker por un cambio de estado accidental).
  app.post('/admin/orders/:order/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    const { status } = req.body || {};
    const VALID = ['created', 'paid', 'pendiente_qr', 'cod_pending', 'ready_to_ship', 'shipped', 'declined', 'cancelada'];
    if (!VALID.includes(status)) return reply.code(400).send({ error: 'estado inválido' });
    updateOrder(o.id, { status });
    const dev = listDevices().find(d => d.order_id === o.id);
    if (dev && status === 'shipped') setDeviceStatus(dev.spkr_id, 'enviado');
    if (dev && status === 'ready_to_ship') setDeviceStatus(dev.spkr_id, 'provisionado');
    // Cancelada/declinada: matar YA los WhatsApp pendientes de la orden (sin esperar
    // la barrida de 15 min) — igual que hace archivar.
    if (ESTADOS_SIN_MENSAJES.includes(status)) {
      const n = cancelAllPendingWa(o.id);
      if (n) logger.info({ orderId: o.id, n }, 'wa: mensajes pendientes cancelados al cancelar la orden');
    }
    logger.info({ orderId: o.id, from: o.status, status }, 'estado de orden cambiado (admin)');
    return { ok: true, status };
  });

  // Panel "Caja" del admin: foto financiera en tiempo real, computada acá para que
  // haya UNA sola verdad. Devuelve:
  //  - resumen por estado de orden (unidades y $)
  //  - caja real: EfiPay + COD ya ENTREGADO (recaudado por la transportadora, en
  //    liquidación de Skydropx) + online cobrado por otra vía (Bre-B propio/Nequi)
  //  - pipeline COD por estado de rastreo (con novedades y devoluciones)
  //  - serie diaria de ventas confirmadas (últimos 14 días)
  app.get('/admin/caja', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const orders = listOrders().filter((o) => !o.archived_at);
    const shipByOrder = new Map(
      listShipments().filter((s) => s.status !== 'cancelled').map((s) => [s.order_id, s]),
    );
    const CONFIRMED = new Set(['shipped', 'ready_to_ship', 'paid', 'cod_pending']);
    const cents = (arr) => arr.reduce((a, o) => a + (o.amount_cents || 0), 0);
    const pack = (arr) => ({ n: arr.length, cents: cents(arr) });

    const conf = orders.filter((o) => CONFIRMED.has(o.status));
    const cod = conf.filter((o) => o.delivery === 'contraentrega');
    const track = (o) => shipByOrder.get(o.id)?.tracking_status || 'sin_guia';

    // Caja real (plata efectivamente cobrada a hoy)
    const efipay = pack(orders.filter((o) => o.efi_payment_id));
    const codEntregado = pack(cod.filter((o) => track(o) === 'delivered'));
    // Órdenes online confirmadas sin EfiPay = cobradas por Bre-B propio / Nequi directo
    // (una orden online no pagada se queda en 'created', que no es estado confirmado).
    const onlineOtro = pack(conf.filter((o) => o.delivery !== 'contraentrega' && !o.efi_payment_id));

    // Pipeline COD por estado de rastreo
    const pipeline = {};
    for (const o of cod) {
      const st = track(o);
      pipeline[st] = pipeline[st] || { n: 0, cents: 0 };
      pipeline[st].n += 1;
      pipeline[st].cents += o.amount_cents || 0;
    }

    // Resumen por estado de orden
    const porEstado = {};
    for (const o of orders) {
      porEstado[o.status] = porEstado[o.status] || { n: 0, cents: 0 };
      porEstado[o.status].n += 1;
      porEstado[o.status].cents += o.amount_cents || 0;
    }

    // Serie diaria de confirmadas, últimos 14 días (fecha en hora de Colombia, UTC-5)
    const dias = [];
    const hoy = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - 5 * 3600e3 - i * 24 * 3600e3).toISOString().slice(0, 10);
      dias.push({ dia: d, n: 0, cents: 0 });
    }
    const idx = new Map(dias.map((d, i) => [d.dia, i]));
    for (const o of conf) {
      const d = new Date(o.created_at - 5 * 3600e3).toISOString().slice(0, 10);
      const i = idx.get(d);
      if (i != null) { dias[i].n += 1; dias[i].cents += o.amount_cents || 0; }
    }

    return {
      generado: Date.now(),
      hoy,
      confirmadas: pack(conf),
      cajaReal: {
        efipay,
        codEntregado,
        onlineOtro,
        totalCents: efipay.cents + codEntregado.cents + onlineOtro.cents,
      },
      codPipeline: pipeline,
      porEstado,
      dias,
    };
  });

  // Renovaciones que vencen pronto (o ya vencidas) para avisar por WhatsApp.
  app.get('/admin/renewals', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const horizonMs = (Number(req.query.days) || 30) * 24 * 3600 * 1000;
    const cutoff = Date.now() + horizonMs;
    return listOrders()
      .filter(o => o.next_charge_at && PAID_STATES.includes(o.status) && o.next_charge_at <= cutoff)
      .map(o => ({
        id: o.id, business_name: o.business_name, phone: o.phone,
        mp_payer_email: o.mp_payer_email, next_charge_at: o.next_charge_at,
        days_left: Math.ceil((o.next_charge_at - Date.now()) / (24 * 3600 * 1000)),
      }))
      .sort((a, b) => a.next_charge_at - b.next_charge_at);
  });

  // ── CLIENTES (gestión): un cliente = una cuenta (account). Vista agregada con
  //    su orden principal (vencimiento), speakers, estado de suscripción. ──
  const DAY = 24 * 3600 * 1000;
  const PERIOD_DAYS = 365; // anual (si pasa a mensual, hacer configurable)

  // Arma el resumen de un cliente a partir de su account.
  function clientSummary(acc) {
    const orders = listOrders().filter(o => o.account_id === acc.id);
    // orden "principal" = la pagada con vencimiento más próximo (o la última)
    const paid = orders.filter(o => PAID_STATES.includes(o.status));
    const main = paid.sort((a, b) => (a.next_charge_at || Infinity) - (b.next_charge_at || Infinity))[0] || orders[0] || null;
    const nextCharge = main?.next_charge_at || null;
    const state = subState(acc, nextCharge);
    const devs = listDevices().filter(d => acc.speaker_id && d.spkr_id === acc.speaker_id);
    return {
      id: acc.id,
      email: acc.email,
      alias: acc.alias || null,
      business_name: main?.business_name || null,
      phone: main?.phone || null,
      payer_email: main?.mp_payer_email || null,
      sub_state: state,                 // activa | por_vencer | vencida | suspendida
      sub_status: acc.sub_status || 'activa',
      next_charge_at: nextCharge,
      days_left: nextCharge ? Math.ceil((nextCharge - Date.now()) / DAY) : null,
      speaker_id: acc.speaker_id || null,
      speakers: devs.length,
      order_id: main?.id || null,
      created_at: acc.created_at,
    };
  }

  app.get('/admin/clients', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return listAccounts().map(a => clientSummary(getAccount(a.id))).sort((a, b) => {
      // ordenar: por vencer/vencidos/suspendidos primero, luego por vencimiento
      const rank = { vencida: 0, por_vencer: 1, suspendida: 2, activa: 3 };
      return (rank[a.sub_state] - rank[b.sub_state]) || ((a.next_charge_at || Infinity) - (b.next_charge_at || Infinity));
    });
  });

  // Estadísticas de latencia del pipeline de pago (global + por comercio + detalle).
  // Query opcional: ?from=<epochMs>&to=<epochMs> filtra el detalle por rango de fecha;
  // ?all=1 devuelve TODAS las muestras del rango (no solo las últimas 50).
  app.get('/admin/latency', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    // Resuelve accountId → nombre del comercio (business_name de su orden, o el email).
    const resolveName = (accountId) => {
      const ord = listOrders().find((o) => o.account_id === accountId && o.business_name);
      if (ord) return ord.business_name;
      const acc = getAccount(accountId);
      return acc ? acc.email : null;
    };
    const from = req.query.from ? Number(req.query.from) : null;
    const to = req.query.to ? Number(req.query.to) : null;
    const all = req.query.all === '1' || req.query.all === 'true';
    // `incidentes`: estado del detector de demoras por banco (auto-aviso audio 120).
    return { ...getLatencyStats(resolveName, { from, to, all }), incidentes: bankStatusSnapshot() };
  });

  // ── Buzón (catch-all): correo que entra al MX a un alias DESCONOCIDO ──
  // (los de clientes conocidos NO se guardan acá; van al buzón de cada cliente).
  // Reemplaza el viejo reenvío del catch-all al correo personal. Agrupado por alias.
  app.get('/admin/inbox', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = listInbox({ limit: 200 }).map((m) => ({
      id: m.id,
      alias: m.alias,
      direction: m.direction || 'in',     // 'in' recibido | 'out' enviado desde el panel
      from: m.from_addr,
      to: m.to_addr,
      subject: m.subject,
      isPayment: Boolean(m.is_payment),
      seen: Boolean(m.seen),
      replied: Boolean(m.replied_at),
      hasBody: (m.text_len || 0) > 0,
      at: m.at,
    }));
    // Resumen por alias: a qué destino llegó cada correo (cuántos, sin leer, pagos).
    const byAliasMap = new Map();
    for (const m of rows) {
      const key = m.alias || '(sin alias)';
      let g = byAliasMap.get(key);
      if (!g) {
        g = { alias: key, count: 0, unseen: 0, payments: 0, lastAt: 0 };
        byAliasMap.set(key, g);
      }
      g.count++;
      if (!m.seen) g.unseen++;
      if (m.isPayment) g.payments++;
      if (m.at > g.lastAt) g.lastAt = m.at;
    }
    const byAlias = [...byAliasMap.values()].sort((a, b) => b.lastAt - a.lastAt);
    return { unseen: unseenInboxCount(), byAlias, mails: rows };
  });

  // Un correo completo (cuerpo). Al abrirlo lo marca leído.
  app.get('/admin/inbox/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const m = getInboxMail(Number(req.params.id));
    if (!m) return reply.code(404).send({ error: 'no encontrado' });
    markInboxSeen(m.id);
    return {
      id: m.id, alias: m.alias, direction: m.direction || 'in',
      from: m.from_addr, to: m.to_addr, subject: m.subject, text: m.text, html: m.html,
      isPayment: Boolean(m.is_payment), replied: Boolean(m.replied_at),
      canReply: Boolean(config.MX_SEND_API_URL && m.from_addr && (m.direction || 'in') === 'in'),
      at: m.at,
    };
  });

  // Redactar un correo NUEVO desde el panel (tu Gmail personal quedó quemado por el reenvío).
  // Sale firmado DKIM desde <alias>@sono.lat (vos elegís el alias). Se guarda en el buzón.
  app.post('/admin/inbox/compose', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!config.MX_SEND_API_URL) return reply.code(501).send({ error: 'Envío saliente no configurado (MX_SEND_API_URL).' });
    const b = req.body || {};
    const alias = String(b.alias || 'hola').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'hola';
    const to = String(b.to || '').trim();
    const subject = String(b.subject || '').trim();
    const text = String(b.text || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return reply.code(400).send({ error: 'Poné un destinatario válido.' });
    if (!text.trim()) return reply.code(400).send({ error: 'Escribí el mensaje.' });

    try {
      const resp = await fetch(`${config.MX_SEND_API_URL.replace(/\/$/, '')}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sono-secret': config.EMAIL_WEBHOOK_SECRET },
        body: JSON.stringify({ fromLocal: alias, fromName: 'Sonó', to, subject, text }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        logger.error({ alias, to, status: resp.status, data }, 'compose: MX rechazó');
        return reply.code(502).send({ error: data.error || `MX respondió ${resp.status}` });
      }
      saveOutboundMail({ alias, to, subject, text, messageId: data.messageId });
      logger.info({ alias, to }, 'compose enviado');
      return { ok: true, messageId: data.messageId };
    } catch (e) {
      logger.error({ alias, to, err: e.message }, 'compose error');
      return reply.code(502).send({ error: e.message });
    }
  });

  // Responder un correo del buzón DESDE el alias que lo recibió (ej. admin@sono.lat),
  // firmado con DKIM por el MX. Hace threading con el Message-ID original.
  app.post('/admin/inbox/:id/reply', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!config.MX_SEND_API_URL) return reply.code(501).send({ error: 'Envío saliente no configurado (MX_SEND_API_URL).' });
    const m = getInboxMail(Number(req.params.id));
    if (!m) return reply.code(404).send({ error: 'no encontrado' });
    if (!m.from_addr) return reply.code(400).send({ error: 'el correo no tiene remitente al cual responder' });

    const { text = '', subject } = req.body || {};
    if (!String(text).trim()) return reply.code(400).send({ error: 'Escribí algo para responder.' });

    const subj = subject || (m.subject && /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject || ''}`.trim());
    // Threading: In-Reply-To = Message-ID original; References = refs + Message-ID.
    const refs = [m.refs, m.message_id].filter(Boolean).join(' ') || undefined;
    try {
      const resp = await fetch(`${config.MX_SEND_API_URL.replace(/\/$/, '')}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sono-secret': config.EMAIL_WEBHOOK_SECRET },
        body: JSON.stringify({
          fromLocal: m.alias || 'admin',   // responde desde admin@sono.lat (el alias que recibió)
          fromName: 'Sonó',
          to: m.from_addr,
          subject: subj,
          text,
          inReplyTo: m.message_id || undefined,
          references: refs,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        logger.error({ id: m.id, status: resp.status, data }, 'inbox reply: MX rechazó');
        return reply.code(502).send({ error: data.error || `MX respondió ${resp.status}` });
      }
      markInboxReplied(m.id);
      logger.info({ id: m.id, to: m.from_addr, from: `${m.alias}@${config.MAIL_DOMAIN}` }, 'inbox reply enviado');
      return { ok: true, messageId: data.messageId };
    } catch (e) {
      logger.error({ id: m.id, err: e.message }, 'inbox reply error');
      return reply.code(502).send({ error: e.message });
    }
  });

  app.delete('/admin/inbox/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ok: deleteInboxMail(Number(req.params.id)) };
  });

  // ── Convocatoria UGC (gestión de aplicaciones) ──
  app.get('/admin/ugc', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { applications: listUgcApplications(), nuevo: countUgcNuevo() };
  });

  app.post('/admin/ugc/:id/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const status = String((req.body || {}).status || '');
    const ok = setUgcStatus(Number(req.params.id), status);
    if (!ok) return reply.code(400).send({ error: 'estado inválido o no encontrado' });
    return { ok: true };
  });

  app.delete('/admin/ugc/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ok: deleteUgcApplication(Number(req.params.id)) };
  });

  app.get('/admin/clients/:id/detail', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    const summary = clientSummary(acc);
    const accOrders = listOrders().filter(o => o.account_id === acc.id);
    const orders = accOrders
      .map(o => ({ id: o.id, status: o.status, business_name: o.business_name, bank: o.bank,
        next_charge_at: o.next_charge_at, hasQr: Boolean(o.qr_path), created_at: o.created_at,
        breb_key: o.breb_key || null, local_name: o.local_name || null,
        // datos del pedido para mostrarlos en el admin (nº orden, plan, entrega, monto)
        plan: o.plan || null, delivery: o.delivery || 'online', amount_cents: o.amount_cents }));
    const allDevices = listDevices();
    const speakersList = allDevices.filter(d => (d.order_id && orders.some(o => o.id === d.order_id)) || (acc.speaker_id && d.spkr_id === acc.speaker_id))
      .map(d => ({ spkr_id: d.spkr_id, mac: d.mac, model: d.model, status: d.status,
        last_seen: d.last_seen, battery: d.battery, ssid: d.ssid }));

    // MULTIPUNTO: un "local" por cada pedido con su llave Bre-B + speaker asignado. Permite
    // ver en el admin cómo se reparte el cliente por llave (qué pago suena en qué speaker).
    const locales = accOrders.map(o => {
      const dev = allDevices.find(d => d.order_id === o.id);
      // la llave puede estar en el device (ya asignado) o en la orden (QR subido, sin device aún)
      const key = (dev && dev.breb_key) || o.breb_key || null;
      const localName = (dev && dev.local_name) || o.local_name || o.business_name || null;
      return {
        order_id: o.id,
        local_name: localName,
        breb_key: key,
        has_key: Boolean(key),
        // llaves adicionales vinculadas a mano (POST /admin/clients/:id/keys)
        extra_keys: dev ? listDeviceKeys(dev.spkr_id) : [],
        spkr_id: dev ? dev.spkr_id : null,
        status: o.status,
        hasQr: Boolean(o.qr_path),
      };
    });
    const isMultipunto = accOrders.length > 1;

    return {
      ...summary,
      email_method: acc.auth_type === 'imap' ? 'imap' : (acc.alias ? 'redirect' : (acc.oauth_provider || 'gmail')),
      change_confirmed: Boolean(acc.change_confirmed),
      only_breb: Boolean(acc.only_breb),   // filtro: solo pagos por llave Bre-B (Bancolombia)
      grace_until: acc.grace_until || null,
      suspended_at: acc.suspended_at || null,
      orders,
      speakers_list: speakersList,
      locales,             // multipunto: lista de locales con su llave + speaker
      is_multipunto: isMultipunto,
      payments: paymentsFor(acc.id, 50),
    };
  });

  // Marcar renovado: extiende el vencimiento un período y reactiva.
  app.post('/admin/clients/:id/renew', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    const orders = listOrders().filter(o => o.account_id === acc.id && PAID_STATES.includes(o.status));
    const main = orders.sort((a, b) => (a.next_charge_at || 0) - (b.next_charge_at || 0))[0];
    if (!main) return reply.code(400).send({ error: 'el cliente no tiene pedido pago' });
    // base = max(hoy, vencimiento actual) para no perder días si renueva antes
    const base = Math.max(Date.now(), main.next_charge_at || Date.now());
    const next = base + PERIOD_DAYS * DAY;
    updateOrder(main.id, { next_charge_at: next });
    setSubStatus(acc.id, 'activa');     // limpia gracia/suspensión
    if (onSubStatusChange) onSubStatusChange(acc.id, 'activa');
    logger.info({ clientId: acc.id, next }, 'cliente renovado');
    return { ok: true, next_charge_at: next, sub_state: 'activa' };
  });

  // Suspender manual (apaga el anuncio de pagos).
  app.post('/admin/clients/:id/suspend', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    setSubStatus(acc.id, 'suspendida');
    if (onSubStatusChange) onSubStatusChange(acc.id, 'suspendida');
    logger.info({ clientId: acc.id }, 'cliente suspendido (manual)');
    return { ok: true, sub_state: 'suspendida' };
  });

  // Renombrar el ALIAS del correo redirigido (ej. viverestiendalaunica-905c → viveres).
  // El alias viejo deja de resolver (sus correos caen al buzón catch-all); el forward_to,
  // los pagos históricos y el vínculo con la orden se conservan. Si ForwardEmail está
  // configurado, también crea allí el alias nuevo (si no, skipped: el MX propio resuelve).
  const RESERVED_ALIASES = new Set(['hola', 'admin', 'soporte', 'info', 'contacto', 'pagos',
    'ventas', 'no-reply', 'noreply', 'mx', 'postmaster', 'abuse', 'webmaster']);
  app.patch('/admin/clients/:id/alias', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    const alias = String(req.body?.alias || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(alias)) {
      return reply.code(400).send({ error: 'alias inválido (a-z, 0-9, punto, guion; 2-31 chars)' });
    }
    if (RESERVED_ALIASES.has(alias)) return reply.code(400).send({ error: 'alias reservado' });
    const clash = getAccountByAlias(alias);
    if (clash && clash.id !== acc.id) {
      return reply.code(409).send({ error: `alias en uso por otra cuenta (${clash.email})` });
    }
    const email = `${alias}@${config.MAIL_DOMAIN}`;
    // Si FE está activo, crear el alias nuevo allí (idempotente; skipped sin token).
    try {
      const fe = await createClientAlias({ name: alias, forwardTo: acc.forwardTo || null });
      if (!fe.ok && !fe.skipped) logger.warn({ alias, err: fe.error }, 'rename alias: FE no lo creó (se continúa)');
    } catch (e) { logger.warn({ alias, err: e.message }, 'rename alias: FE error (se continúa)'); }
    renameAccountAlias(acc.id, alias, email);
    logger.info({ clientId: acc.id, from: acc.alias, to: alias }, 'alias renombrado (admin)');
    return { ok: true, email, previous: acc.email };
  });

  // MULTI-LLAVE: vincular manualmente una llave Bre-B ADICIONAL al speaker de un
  // cliente (ej. además del QR del local, la llave de su celular). Los pagos que
  // lleguen a esa llave suenan en ese speaker y salen en su Libreta.
  //   POST   /admin/clients/:id/keys  { spkr_id, key }  → agrega
  //   DELETE /admin/clients/:id/keys  { spkr_id, key }  → quita (solo adicionales)
  const deviceOfClient = (acc, spkrId) => {
    if (!spkrId) return null;
    return listDevicesByAccount(acc.id).find((d) => d.spkr_id === spkrId) || null;
  };
  app.post('/admin/clients/:id/keys', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    const { spkr_id } = req.body || {};
    const key = req.body?.key ? normalizeKey(String(req.body.key)) : null;
    if (!key) return reply.code(400).send({ error: 'falta la llave' });
    const dev = deviceOfClient(acc, spkr_id);
    if (!dev) return reply.code(404).send({ error: 'ese speaker no es de este cliente' });
    // La llave no puede estar ya en OTRO device de la cuenta (rompería el ruteo).
    const clash = findDeviceByKey(acc.id, key);
    if (clash && clash.spkr_id !== dev.spkr_id) {
      return reply.code(409).send({ error: `llave ya vinculada al speaker ${clash.spkr_id}` });
    }
    if (dev.breb_key === key) {
      return reply.code(409).send({ error: 'esa ya es la llave principal de este speaker' });
    }
    addDeviceKey(dev.spkr_id, key);
    logger.info({ clientId: acc.id, spkr: dev.spkr_id, key }, 'admin: llave adicional vinculada');
    return { ok: true, spkr_id: dev.spkr_id, keys: listDeviceKeys(dev.spkr_id) };
  });
  app.delete('/admin/clients/:id/keys', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const key = src.key ? normalizeKey(String(src.key)) : null;
    if (!key) return reply.code(400).send({ error: 'falta la llave' });
    const dev = deviceOfClient(acc, src.spkr_id);
    if (!dev) return reply.code(404).send({ error: 'ese speaker no es de este cliente' });
    const removed = removeDeviceKey(dev.spkr_id, key);
    if (!removed) return reply.code(404).send({ error: 'esa llave no está vinculada como adicional' });
    logger.info({ clientId: acc.id, spkr: dev.spkr_id, key }, 'admin: llave adicional quitada');
    return { ok: true, spkr_id: dev.spkr_id, keys: listDeviceKeys(dev.spkr_id) };
  });

  // Toggle "solo pagos por llave Bre-B" (silencia transferencias directas por número de
  // cuenta). ⚠️ Solo tiene efecto real en cuentas Bancolombia (Nequi/BBVA no traen la
  // llave en el correo). body { value: true|false }.
  app.patch('/admin/clients/:id/only-breb', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    const value = Boolean(req.body?.value);
    setAccountOnlyBreb(acc.id, value);
    logger.info({ clientId: acc.id, only_breb: value }, 'admin: toggle only_breb');
    return { ok: true, only_breb: value };
  });

  // Reactivar (vuelve a anunciar).
  app.post('/admin/clients/:id/reactivate', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    setSubStatus(acc.id, 'activa');
    if (onSubStatusChange) onSubStatusChange(acc.id, 'activa');
    logger.info({ clientId: acc.id }, 'cliente reactivado');
    return { ok: true, sub_state: 'activa' };
  });

  app.get('/admin/devices', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    // Defensa: si la batería quedó guardada como voltaje crudo (mV, >100) de antes del
    // fix, convertirla a % al vuelo para no mostrar "4030%".
    const battPct = (v) => {
      if (v == null) return null;
      if (v <= 100) return v;
      return Math.max(0, Math.min(100, Math.round(((v - 3400) / (4150 - 3400)) * 100)));
    };
    // Inventario: a los asignados se les agrega A QUIÉN (negocio + ciudad de la orden).
    const byOrder = new Map(listOrders().map((o) => [o.id, o]));
    return listDevices().map((d) => {
      const o = d.order_id ? byOrder.get(d.order_id) : null;
      return {
        ...d,
        battery: battPct(d.battery),
        assigned_to: o ? (o.business_name || o.customer_email || 'Sin nombre') : null,
        assigned_city: o?.city || null,
      };
    });
  });

  app.post('/admin/devices', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { spkr_id, mac, imei, model, label, mqtt_pass } = req.body || {};
    if (!spkr_id) return reply.code(400).send({ error: 'falta spkr_id' });
    const dev = createDevice({ spkrId: spkr_id, mac, imei, model, label, mqttPass: mqtt_pass });
    return { ok: true, device: dev };
  });

  // Pedir telemetría al speaker: publica {cmd:'getinfo'}; el aparato responde por
  // su /status y el handler de auto-provisioning actualiza la fila (señal, batería, etc).
  app.post('/admin/devices/:spkr/getinfo', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const dev = getDevice(req.params.spkr);
    if (!dev) return reply.code(404).send({ error: 'device no registrado' });
    try {
      await publishCommand(dev.spkr_id, { cmd: 'getinfo' });
      return { ok: true };
    } catch (e) {
      logger.error({ spkr: dev.spkr_id, err: e.message }, 'getinfo publish failed');
      return reply.code(502).send({ error: 'no se pudo contactar el speaker' });
    }
  });

  // PANEL DE PRUEBAS: mandar un comando MQTT arbitrario a cualquier speaker.
  // Permite spkr_id NO registrado (para probar unidades recién provisionadas).
  // body: { cmd: object }  ej. { cmd: { cmd:'voice', playAudibleMsg:'037' } }
  app.post('/admin/devices/:spkr/cmd', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const spkr = String(req.params.spkr || '').trim();
    if (!spkr) return reply.code(400).send({ error: 'falta spkr_id' });
    const cmd = req.body && req.body.cmd;
    if (!cmd || typeof cmd !== 'object') {
      return reply.code(400).send({ error: 'falta cmd (objeto JSON)' });
    }
    try {
      await publishCommand(spkr, cmd);
      logger.info({ spkr, cmd }, 'admin test cmd publish');
      return { ok: true, topic: `speakers/${spkr}/cmd`, sent: cmd };
    } catch (e) {
      logger.error({ spkr, err: e.message }, 'admin test cmd failed');
      return reply.code(502).send({ error: 'no se pudo publicar al speaker' });
    }
  });

  // BROADCAST: reproducir un audio (por ID de WAV) en varios speakers a la vez.
  // Sin filtro va a TODOS los registrados; con `filtro.banco` va SOLO a los speakers
  // de clientes que reciben pagos de ese banco (misma segmentación que el auto-aviso
  // de demoras: pagos de los últimos 30 días, cuentas suspendidas excluidas).
  // body: { audioId: "120", filtro?: { banco?: "nequi" } }
  const BROADCAST_BANK_WINDOW_MS = 30 * 24 * 3600 * 1000; // igual que el auto-aviso 120
  function resolverSpeakers(filtro) {
    const banco = String((filtro && filtro.banco) || '').trim().toLowerCase();
    if (banco) return speakersForBank(banco, Date.now() - BROADCAST_BANK_WINDOW_MS);
    return listDevices().map((d) => d.spkr_id);
  }
  app.post('/admin/broadcast', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const audioId = String((req.body && req.body.audioId) || '').trim();
    if (!/^[0-9]{1,3}(-[0-9]{1,3})*$/.test(audioId)) {
      return reply.code(400).send({ error: 'audioId inválido (IDs de WAV, ej "120")' });
    }
    const filtro = (req.body && req.body.filtro) || null;
    const banco = String((filtro && filtro.banco) || '').trim().toLowerCase() || null;
    const candidatos = resolverSpeakers(filtro);
    if (candidatos.length === 0) {
      return reply.code(400).send({
        error: banco
          ? `ningún speaker recibió pagos de "${banco}" en los últimos 30 días`
          : 'no hay speakers a los que enviar',
      });
    }
    // SOLO online (ping getinfo, ~3s) y qos 0: a un speaker offline el broker NO
    // le guarda el aviso — que suene al reconectar, fuera de contexto, confunde.
    const speakers = await filterOnline(candidatos);
    const offline = candidatos.filter((s) => !speakers.includes(s));
    if (speakers.length === 0) {
      return reply.code(400).send({
        error: `ningún speaker online (${candidatos.length} candidatos, todos offline)`,
        offline,
      });
    }
    const cmd = { cmd: 'voice', playAudibleMsg: audioId };
    const results = await Promise.allSettled(
      speakers.map((spkr) => publishCommand(spkr, cmd, { qos: 0 })),
    );
    const enviados = results.filter((r) => r.status === 'fulfilled').length;
    const fallidos = speakers.length - enviados;
    logger.info({ audioId, banco, enviados, fallidos, offline: offline.length }, 'admin broadcast');
    return { ok: true, audioId, banco, enviados, fallidos, offline, speakers };
  });

  // -------------------------------------------------------------------------
  // Instagram (publicar desde el panel admin con la Graph API)
  // -------------------------------------------------------------------------

  const IG_MIME_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'video/mp4': 'mp4', 'video/quicktime': 'mov',
  };
  const isVideoMime = (m) => String(m || '').startsWith('video/');

  // Sirve los archivos temporales para que Instagram los descargue. Público a propósito
  // (Graph entra sin auth), pero con nombre aleatorio (no adivinable) y vida corta.
  const serveMedia = (dir) => async (req, reply) => {
    const name = path.basename(req.params.file); // evita path traversal
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp)) return reply.code(404).send({ error: 'no encontrado' });
    const ext = path.extname(name).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'mp4' ? 'video/mp4'
      : ext === 'mov' ? 'video/quicktime' : 'image/jpeg';
    reply.header('Content-Type', mime);
    return reply.send(fs.readFileSync(fp));
  };
  app.get('/ig-media/:file', serveMedia(IG_DIR));
  // Archivos de posts PROGRAMADOS (Graph los descarga al publicar a la hora indicada).
  app.get('/ig-scheduled/:file', serveMedia(igScheduler.mediaDir));

  // Estado de la integración: si está configurada y, si lo está, datos de la cuenta IG.
  app.get('/admin/ig/account', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!config.hasInstagram) return { configured: false };
    try {
      const acc = await getInstagramAccount();
      return { configured: true, account: acc };
    } catch (e) {
      logger.error({ err: e.message }, 'ig account failed');
      return { configured: true, account: null, error: e.message };
    }
  });

  // Analizar 1 archivo con Gemini Vision y generar un caption de marketing Sonó.
  // multipart: campo "file" (imagen/video) + opcional "hint" (texto de contexto).
  app.post('/admin/ig/caption', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!config.GEMINI_API_KEY) return reply.code(503).send({ error: 'IA no configurada (falta GEMINI_API_KEY)' });
    try {
      let buffer = null, mimeType = '', hint = '';
      for await (const part of req.parts()) {
        if (part.type === 'file' && !buffer) {
          mimeType = part.mimetype;
          buffer = await part.toBuffer();
        } else if (part.type === 'file') {
          await part.toBuffer();
        } else if (part.fieldname === 'hint') {
          hint = String(part.value || '');
        }
      }
      if (!buffer) return reply.code(400).send({ error: 'Subí una imagen o video para analizar.' });
      const captions = await generateCaption(buffer, mimeType, hint);
      logger.info({ mimeType, n: captions.length }, 'ig: captions generados');
      return { ok: true, captions };
    } catch (e) {
      logger.error({ err: e.message }, 'ig caption failed');
      return reply.code(502).send({ error: e.message || 'No se pudo generar el caption.' });
    }
  });

  // Publicar: multipart con N archivos (campo "files") + caption (campo "caption").
  // 1 archivo = foto/reel · 2+ = carrusel. Los archivos se guardan, se les da URL
  // pública, se publican vía Graph y se borran.
  app.post('/admin/ig/publish', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!config.hasInstagram) return reply.code(503).send({ error: 'Instagram no configurado' });

    const saved = []; // {filename, type}
    let caption = '';
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const ext = IG_MIME_EXT[part.mimetype];
          if (!ext) { await part.toBuffer(); continue; } // ignorar tipos no soportados
          const buf = await part.toBuffer();
          const filename = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
          fs.writeFileSync(path.join(IG_DIR, filename), buf);
          saved.push({ filename, type: isVideoMime(part.mimetype) ? 'video' : 'image' });
        } else if (part.fieldname === 'caption') {
          caption = String(part.value || '');
        }
      }

      if (saved.length === 0) {
        return reply.code(400).send({ error: 'Subí al menos una imagen o video (jpg/png/mp4).' });
      }
      if (saved.length > 10) {
        return reply.code(400).send({ error: 'Máximo 10 archivos por carrusel.' });
      }

      const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
      const items = saved.map((s) => ({ url: `${base}/ig-media/${s.filename}`, type: s.type }));

      logger.info({ n: items.length, caption: caption.slice(0, 40) }, 'ig: publicando');
      const result = await publishToInstagram({ items, caption });
      return { ok: true, ...result };
    } catch (e) {
      logger.error({ err: e.message }, 'ig publish failed');
      return reply.code(502).send({ error: e.message || 'No se pudo publicar en Instagram.' });
    } finally {
      for (const s of saved) {
        try { fs.unlinkSync(path.join(IG_DIR, s.filename)); } catch {}
      }
    }
  });

  // Feed: últimos posts publicados de la cuenta (grilla tipo perfil).
  app.get('/admin/ig/media', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!config.hasInstagram) return { media: [] };
    try {
      const media = await getInstagramMedia(Number(req.query.limit) || 12);
      return { media };
    } catch (e) {
      logger.error({ err: e.message }, 'ig media failed');
      return reply.code(502).send({ error: e.message });
    }
  });

  // Posts PROGRAMADOS: listar.
  app.get('/admin/ig/scheduled', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
    return {
      posts: igScheduler.list().map((p) => ({
        id: p.id, caption: p.caption, status: p.status,
        scheduled_at: p.scheduled_at, created_at: p.created_at,
        published_at: p.published_at || null, permalink: p.permalink, error: p.error,
        media: p.files.map((f) => ({ url: `${base}/ig-scheduled/${f.filename}`, type: f.type })),
      })),
    };
  });

  // Programar un post: multipart (files + caption + scheduled_at en epoch ms).
  app.post('/admin/ig/scheduled', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!config.hasInstagram) return reply.code(503).send({ error: 'Instagram no configurado' });
    const saved = [];
    let caption = '', scheduledAt = 0;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const ext = IG_MIME_EXT[part.mimetype];
          if (!ext) { await part.toBuffer(); continue; }
          const buf = await part.toBuffer();
          const filename = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
          fs.writeFileSync(path.join(igScheduler.mediaDir, filename), buf);
          saved.push({ filename, type: isVideoMime(part.mimetype) ? 'video' : 'image' });
        } else if (part.fieldname === 'caption') {
          caption = String(part.value || '');
        } else if (part.fieldname === 'scheduled_at') {
          scheduledAt = Number(part.value) || 0;
        }
      }
      if (saved.length === 0) return reply.code(400).send({ error: 'Subí al menos una imagen o video.' });
      if (saved.length > 10) return reply.code(400).send({ error: 'Máximo 10 archivos por carrusel.' });
      if (!scheduledAt || scheduledAt < Date.now() - 60000) {
        for (const s of saved) { try { fs.unlinkSync(path.join(igScheduler.mediaDir, s.filename)); } catch {} }
        return reply.code(400).send({ error: 'Elegí una fecha/hora futura.' });
      }
      const post = igScheduler.enqueue(saved, caption, scheduledAt);
      return { ok: true, id: post.id, scheduled_at: post.scheduled_at };
    } catch (e) {
      for (const s of saved) { try { fs.unlinkSync(path.join(igScheduler.mediaDir, s.filename)); } catch {} }
      logger.error({ err: e.message }, 'ig schedule failed');
      return reply.code(502).send({ error: e.message || 'No se pudo programar el post.' });
    }
  });

  // Cancelar un post programado (borra sus archivos).
  app.delete('/admin/ig/scheduled/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const ok = igScheduler.remove(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'post no encontrado' });
    return { ok: true };
  });

  // Publicar YA un post programado (adelantar).
  app.post('/admin/ig/scheduled/:id/publish', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try {
      const result = await igScheduler.publishNow(req.params.id);
      return { ok: true, ...result };
    } catch (e) {
      logger.error({ id: req.params.id, err: e.message }, 'ig publishNow failed');
      return reply.code(502).send({ error: e.message });
    }
  });

  // -------------------------------------------------------------------------
  // Gmail Pub/Sub + utilidades existentes
  // -------------------------------------------------------------------------

  app.post('/webhook/gmail', async (req, reply) => {
    if (config.PUBSUB_VERIFICATION_TOKEN) {
      const token = req.query.token || req.headers['x-pubsub-token'];
      if (token !== config.PUBSUB_VERIFICATION_TOKEN) {
        return reply.code(401).send({ error: 'invalid token' });
      }
    }
    reply.code(204).send();
    setImmediate(async () => {
      try {
        await handlePubSubPush(req.body, (payment) => { if (onPaymentDetected) onPaymentDetected(payment); });
      } catch (e) { logger.error({ err: e.message }, 'pubsub handler error'); }
    });
  });

  // Webhook del Cloudflare Email Worker: recibe un correo redirigido a <alias>@sono.lat.
  // El Worker manda { alias, from, subject, text } firmado con EMAIL_WEBHOOK_SECRET.
  // Modelo stateless: NO se guarda el correo. Si es un pago → suena el speaker. Se
  // responde { forwardTo } para que el Worker reenvíe el correo al cliente (transparente).
  app.post('/webhook/email', async (req, reply) => {
    // Auth: secreto compartido (header). Sin esto, cualquiera podría falsear pagos.
    const secret = req.headers['x-sono-secret'];
    if (!config.EMAIL_WEBHOOK_SECRET || secret !== config.EMAIL_WEBHOOK_SECRET) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // Medición de latencia (igual que /webhook/email-fe). Este endpoint lo usa el MX
    // propio (mx.sono.lat), así que también debe alimentar el panel /admin → Latencia.
    const lat = startLatency(req.body || {});

    const { alias, from = '', subject = '', text = '', html = '', messageId = null, references = null } = req.body || {};
    if (!alias) return reply.code(400).send({ error: 'alias requerido' });

    const account = getAccountByAlias(String(alias).toLowerCase());
    if (!account) {
      // Alias desconocido: no reenviamos a ciegas (no sabemos a quién), pero SÍ lo
      // guardamos en el buzón (catch-all) para verlo y responder en /admin → Buzón.
      // Antes esto se reenviaba al correo personal; ahora queda en el panel.
      try { saveInboxMail({ alias, accountId: null, from, subject, text, html, isPayment: false, messageId, references }); }
      catch (e) { logger.error({ alias, err: e.message }, 'inbox save (desconocido) error'); }
      logger.warn({ alias }, 'email webhook: alias desconocido (guardado en buzón)');
      return { ok: true, forwardTo: null };
    }

    // Dedupe: el MX/Worker puede reintentar el POST (timeout/5xx) con el mismo correo.
    // Mismo guard que /webhook/email-fe: si ya procesamos este Message-ID no se vuelve
    // a anunciar ni a persistir. SÍ devolvemos forwardTo: el reintento debe seguir
    // reenviando el correo al cliente (el forward es idempotente, el anuncio no).
    if (messageId && isDuplicate(`${alias}:${messageId}`)) {
      logger.info({ alias, messageId }, 'email webhook duplicado, ignorado');
      return { ok: true, duplicate: true, forwardTo: account.forwardTo || null };
    }

    // ¿Es una notificación de pago? Parseamos SOLO para extraer monto+banco.
    // PRIORIDAD: el pago va PRIMERO (hacer sonar el IoT con el mínimo delay).
    let wasPayment = false;
    try {
      const result = parseEmail({ from: String(from).toLowerCase(), subject, text, html });
      if (result && onPaymentDetected && dropByOnlyBreb(account, result)) {
        wasPayment = true;
        logger.info({ alias, accountId: account.id, amount: result.amount, bank: result.bank },
          'only_breb: pago sin llave (transferencia directa), no se anuncia ni se registra');
      } else if (result && onPaymentDetected) {
        wasPayment = true;
        const route = pickSpeaker(account, result);
        logger.info({ alias, accountId: account.id, ...result, routedTo: route.speakerId, unrouted: route.unrouted || false }, 'payment detected (email webhook)');
        if (route.unrouted) {
          logger.warn({ alias, accountId: account.id, amount: result.amount, key: route.key },
            'multipunto: pago NO ruteado (llave sin local), no se anuncia');
          // Persistir para "La Libreta": el cliente lo ve como "local por confirmar".
          // NO va a announceLog ni suena en ningún speaker.
          // Los EGRESOS ("Transferiste $X") NO se persisten: son plata que sale, no
          // ventas (announcePayment ya los corta en el camino ruteado). msgId permite
          // que el índice único (account_id, msg_id) dedupee reintentos del MX.
          if (result.direction !== 'out') {
            try {
              recordPayment({
                accountId: account.id, amount: result.amount, bank: result.bank, payer: null,
                brebKey: route.key || result.brebKey || null,
                speakerId: null, localName: null, unrouted: true,
                msgId: messageId || null,
              });
            } catch (e) { logger.error({ accountId: account.id, err: e.message }, 'no se pudo persistir pago unrouted'); }
          }
        } else {
          onPaymentDetected({
            ...result,
            // Nequi/Daviplata no traen llave en el correo: heredar la del QR del local que sonó.
            brebKey: result.brebKey || route.deviceKey || null,
            accountId: account.id,
            speakerId: route.speakerId,
            localName: route.localName || null,
            messageId,
            alias,
            from, subject,
            _lat: lat,
          });
        }
      }
      // Checkout Bre-B propio: si este pago entró a la cuenta de pagos de Sonó,
      // matchear contra los intents (después del anuncio, no le agrega latencia).
      if (result) settleOwnBrebPayment(alias, result);
    } catch (e) {
      logger.error({ alias, err: e.message }, 'email webhook parse error');
    }

    // Si NO fue un pago, ¿es un código de confirmación del banco (cambio de correo)?
    // Lo capturamos efímero para mostrarlo en el onboarding (Fase 3). No se persiste.
    if (!wasPayment) {
      try {
        if (maybeCaptureOtp(account.id, { subject, text, html })) {
          logger.info({ alias, accountId: account.id }, 'otp capturado (email webhook)');
        }
      } catch (e) {
        logger.error({ alias, err: e.message }, 'otp capture error');
      }
    }

    // NO guardamos en el buzón los correos de clientes conocidos: esos se reenvían a
    // su buzón y le corresponden a cada cliente por separado. El buzón de /admin es
    // SOLO el catch-all (alias desconocidos, ver arriba).

    // Reenvío transparente: devolvemos a dónde reenviar (el MX hace el forward).
    // forwardTo viene descifrado por hydrateAccount. Si no hay, el MX no reenvía.
    return { ok: true, forwardTo: account.forwardTo || null };
  });

  // ── Cola de WhatsApp: el agente de la PC del dueño consume por polling ──────────
  const waAuth = (req, reply) => {
    const secret = req.headers['x-sono-secret'];
    if (!config.EMAIL_WEBHOOK_SECRET || secret !== config.EMAIL_WEBHOOK_SECRET) {
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    return true;
  };

  app.get('/wa/pending', async (req, reply) => {
    if (!waAuth(req, reply)) return;
    // Si un enviador vive en la VM, el agente de la PC no recibe nada (evita doble
    // envío si alguien abre el .bat viejo). OJO: para la Cloud API se consulta el
    // estado RUNTIME (isWaCloudActive), no la config — con plantillas sin aprobar
    // el agente PC sigue siendo el enviador y la cola nunca se queda huérfana.
    if (config.hasEvolution || isWaCloudActive()) return { messages: [], settings: getWaSettings() };
    touchWaAgent(); // heartbeat: el agente está vivo
    const settings = getWaSettings();
    if (!settings.enabled) return { messages: [], settings }; // OFF global
    // Fuera de horario activo o con el tope diario lleno NO se entregan mensajes:
    // el agente viejo reclama ANTES de chequear hora/tope, y todo lo reclamado
    // quedaba atascado en 'sending' sin enviarse (bug 17-jul: PC prendida a las
    // 7:38 dejó la cola entera en "Enviando"). El chequeo vive acá, en el server,
    // para que ninguna versión del agente pueda reclamar lo que no va a enviar.
    if (!withinActiveHours(bogotaHour(), settings.active_hour_start, settings.active_hour_end)) {
      return { messages: [], settings };
    }
    const sentToday = countWaSentSince(startOfBogotaDay());
    if (sentToday >= settings.daily_cap) return { messages: [], settings };
    const limit = Math.min(Number(req.query.limit) || 5, 50, settings.daily_cap - sentToday);
    const rows = claimWaPending(limit);
    return {
      messages: rows.map((r) => ({
        id: r.id, phone: r.phone, body: r.body, order_id: r.order_id, kind: r.kind,
      })),
      settings,
    };
  });

  // PDF de la guía para el agente (adjuntarlo al WhatsApp kind='envio'). Mismo proxy que
  // /admin/orders/:id/label-pdf pero con auth de AGENTE (x-sono-secret), no requireAdmin:
  // el agente de la PC no tiene sesión admin. Baja el PDF fresco de Skydropx al vuelo.
  app.get('/wa/label/:orderId', async (req, reply) => {
    if (!waAuth(req, reply)) return;
    const row = getShipmentByOrder(req.params.orderId);
    if (!row || !row.skydropx_id) return reply.code(404).send({ error: 'sin envío' });
    if (!config.hasSkydropx) return reply.code(503).send({ error: 'skydropx no configurado' });
    try {
      const label = extractLabel(await getShipment(row.skydropx_id));
      if (!label.labelUrl) return reply.code(409).send({ error: 'la guía aún no está lista' });
      if (label.labelUrl !== row.label_url) updateShipmentRow(row.id, { label_url: label.labelUrl });
      const pdf = await fetchLabelPdf(label.labelUrl);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="guia-${row.tracking || row.id}.pdf"`)
        .send(pdf);
    } catch (e) {
      req.log?.error?.({ err: e }, 'wa/label falló');
      return reply.code(502).send({ error: 'no se pudo bajar la guía' });
    }
  });

  app.post('/wa/sent', async (req, reply) => {
    if (!waAuth(req, reply)) return;
    const { id, ok, error } = req.body || {};
    if (!id) return reply.code(400).send({ error: 'falta id' });
    markWaSent(id, Boolean(ok), error || null);
    return { ok: true };
  });

  // ── WhatsApp Cloud API oficial: webhook de Meta (statuses reales + entrantes) ──
  // GET = verificación de suscripción (echo de hub.challenge). POST = eventos; se
  // autentica con ?key=<verify token> embebido en la URL del callback (Fastify no
  // conserva el raw body para validar X-Hub-Signature-256; la key por query es el
  // mismo patrón que ya usa /admin con EMAIL_WEBHOOK_SECRET).
  app.get('/webhook/wacloud', async (req, reply) => {
    const q = req.query || {};
    if (
      q['hub.mode'] === 'subscribe' &&
      config.WA_CLOUD_WEBHOOK_VERIFY_TOKEN &&
      q['hub.verify_token'] === config.WA_CLOUD_WEBHOOK_VERIFY_TOKEN
    ) {
      return reply.send(q['hub.challenge']);
    }
    return reply.code(403).send('forbidden');
  });

  app.post('/webhook/wacloud', async (req, reply) => {
    if (!config.WA_CLOUD_WEBHOOK_VERIFY_TOKEN || req.query?.key !== config.WA_CLOUD_WEBHOOK_VERIFY_TOKEN) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    // Procesar sin lanzar y responder 200 SIEMPRE: ante errores repetidos Meta
    // reintenta con backoff y puede terminar desuscribiendo el webhook.
    try {
      for (const entry of req.body?.entry || []) {
        for (const change of entry.changes || []) {
          const v = change.value || {};
          // Estado REAL de cada mensaje enviado (por wamid): la verdad de entrega.
          // Solo estados conocidos: un valor nuevo de Meta no debe quedar grabado
          // como delivery inicial (bloquearía los upgrades sent→delivered→read).
          for (const st of v.statuses || []) {
            if (!['sent', 'delivered', 'read', 'failed'].includes(st.status)) continue;
            const err = st.errors?.[0]
              ? `${st.errors[0].code}: ${st.errors[0].title || st.errors[0].message || ''}`
              : null;
            // 0 filas = el status llegó ANTES de que markWaSent persistiera el wamid
            // (carrera real: Meta dispara el webhook en ms). Un reintento diferido
            // de 3s cubre la ventana sin bloquear la respuesta a Meta.
            if (updateWaDeliveryByWamid(st.id, st.status, err) === 0) {
              setTimeout(() => {
                try { updateWaDeliveryByWamid(st.id, st.status, err); } catch { /* best effort */ }
              }, 3000);
            }
            if (st.status === 'failed') req.log?.warn?.({ wamid: st.id, err }, 'wa-cloud: entrega FALLÓ');
          }
          // Respuestas de clientes ("escríbenos por aquí"): quedan en wa_inbound y
          // avisan por push al iPhone (mismo canal que las escaladas del bot web).
          for (const msg of v.messages || []) {
            const name = v.contacts?.[0]?.profile?.name || null;
            const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];
            const media = MEDIA_TYPES.includes(msg.type) ? msg[msg.type] : null;
            const body = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title
              || media?.caption || (media ? `[${msg.type}]` : `[${msg.type}]`);
            if (insertWaInbound({ id: msg.id, phone: msg.from, name, type: msg.type, body })) {
              logger.info({ from: msg.from, type: msg.type, hasMedia: Boolean(media?.id) }, 'wa-cloud: mensaje entrante');
              // Media: descargar YA en background (el link de Graph expira en ~5 min)
              // y colgar el archivo al mensaje; el panel lo pinta al siguiente poll.
              if (media?.id) {
                downloadWaMedia(media.id)
                  .then(({ path: mediaPath, mime }) => {
                    setWaInboundMedia(msg.id, mediaPath, mime);
                    logger.info({ msgId: msg.id, mime }, 'wa-cloud: media descargada');
                  })
                  .catch((e) => logger.error({ err: e.message, type: msg.type, mediaId: media.id }, 'wa-cloud: descarga de media falló'));
              }
              notifyAdmins({
                title: `🟢 WhatsApp · ${name || '+' + msg.from}`,
                body: media ? `📎 ${msg.type}` : String(body).slice(0, 120),
                url: `/soporte-app/#/conv/wa:${msg.from}`,
                tag: `wa-${msg.from}`,
              }).then((r2) => logger.info({ sent: r2.sent }, 'wa-cloud: push entrante enviado'))
                .catch((e) => logger.warn({ err: e.message }, 'wa-cloud: push entrante falló'));
            }
          }
        }
      }
    } catch (e) {
      req.log?.error?.({ err: e.message }, 'wa-cloud: webhook error');
    }
    return { ok: true };
  });

  // ── Panel admin de WhatsApp: cola, heartbeat del agente, config anti-ban ────
  app.get('/admin/wa', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const agentLastSeen = getWaAgentLastSeen();
    const online = agentLastSeen != null && Date.now() - agentLastSeen < 60 * 1000;
    return {
      counts: countWaByStatus(),
      agent: { lastSeen: agentLastSeen, online },
      settings: getWaSettings(),
      messages: listWaOutbox().slice(-200).reverse(),
      // Cloud API: canal activo + respuestas de clientes (wa_inbound del webhook).
      cloud: { active: isWaCloudActive() },
      inbound: listWaInbound(50),
    };
  });

  // (Las conversaciones de WhatsApp del CRM viven en /soporte/admin/* —
  //  support-routes.js las integra al panel /soporte-app junto al chat web.)

  app.patch('/admin/wa/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const b = req.body || {};
    const allowed = ['enabled', 'active_hour_start', 'active_hour_end', 'daily_cap', 'min_delay_ms', 'max_delay_ms'];
    const patch = {};
    for (const k of allowed) if (k in b) patch[k] = b[k];
    return { settings: setWaSettings(patch) };
  });

  app.post('/admin/wa/:id/retry', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ok: requeueWa(req.params.id) };
  });

  app.post('/admin/wa/:id/cancel', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ok: cancelWa(req.params.id) };
  });

  // Resetea el paso "Conectar el correo" de una orden para que el cliente lo rehaga
  // desde 0 (el wizard &correo=1 vuelve a pedir el correo en vez de decir "listo").
  // NO borra la cuenta ni el alias: los pagos históricos cuelgan de la cuenta y el
  // alias es inmutable por orden — al rehacer, el flujo reencuentra los mismos
  // (accountId = order.account_id || order.id, ver /activar/:order/email-redirect).
  const resetEmailStep = (order) => {
    const accId = order.account_id || null;
    if (accId) {
      try { resetChangeConfirmed(accId); } catch { /* la cuenta pudo no existir */ }
      try { clearOtp(accId); } catch { /* efímero */ }
    }
    updateOrder(order.id, { account_id: null });
    return accId;
  };

  app.post('/admin/orders/:id/reset-email', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const order = getOrder(req.params.id);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    const accId = resetEmailStep(order);
    logger.info({ orderId: order.id, accountId: accId }, 'paso de correo reseteado (admin)');
    return { ok: true, hadAccount: Boolean(accId) };
  });

  app.post('/admin/wa/enqueue', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { order: orderId, kind: rawKind } = req.body || {};
    const order = getOrder(orderId);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    const kind = ['activacion', 'recordatorio_3h', 'recordatorio_24h', 'envio', 'libreta', 'correo', 'qr_problema', 'conexion', 'qr_incompatible'].includes(rawKind) ? rawKind : 'activacion';
    // Mandar "Conectar el correo" implica que el cliente lo va a REHACER: se resetea
    // el paso automáticamente para que el link del mensaje arranque desde 0.
    if (kind === 'correo') {
      const accId = resetEmailStep(order);
      logger.info({ orderId: order.id, accountId: accId }, 'wa correo: paso de correo reseteado');
    }
    return { ok: enqueueWhatsAppForce(order, kind) };
  });

  // Renombrar el LOCAL de un device (nombre del comercio en los chips de La Libreta).
  // Propaga el nombre a las ventas históricas de esa llave (renameDeviceLocal).
  app.patch('/admin/devices/:spkr/local', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const name = String(req.body?.name || '').trim().slice(0, 40);
    if (!name) return reply.code(400).send({ error: 'falta el nombre' });
    const r = renameDeviceLocal(req.params.spkr, name);
    if (!r) return reply.code(404).send({ error: 'device no encontrado' });
    logger.info({ spkr: req.params.spkr, name, pagos: r.pagos }, 'local renombrado');
    return { ok: true, pagos: r.pagos };
  });

  // Onboarding Fase 3: el frontend hace polling acá para (a) mostrar el OTP del banco y
  // (b) saber si el cambio ya se confirmó (el banco mandó el "correo cambiado con éxito")
  // para cerrar el onboarding automático. Efímero/scopeado por order id (no adivinable).
  // `at` = cuándo se capturó el código y `now` = reloj del servidor: el front descarta
  // códigos capturados ANTES de que el cliente llegara a la pantalla del banco (un OTP
  // de un intento anterior, aún dentro del TTL, confunde: "me muestra un código viejo").
  app.get('/activar/:order/otp', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order || !order.account_id) return { code: null, at: null, now: Date.now(), confirmed: false };
    const otp = readOtp(order.account_id);
    const acc = getAccount(order.account_id);
    return {
      code: otp ? otp.code : null,
      at: otp ? otp.at : null,
      now: Date.now(),
      confirmed: Boolean(acc && acc.change_confirmed),
    };
  });

  // Confirmación MANUAL: el cliente dice "ya cambié el correo en el banco" y avanza, por si
  // el correo de confirmación del banco no llega o no lo detectamos (no debe quedar atascado).
  // Marca change_confirmed igual que la vía automática → el wizard avanza al QR.
  app.post('/activar/:order/email-confirmed', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!order.account_id) return reply.code(409).send({ error: 'primero conecta tu correo' });
    markChangeConfirmed(order.account_id);
    logger.info({ orderId: order.id, accountId: order.account_id }, 'cambio de correo confirmado MANUALMENTE por el cliente');
    return { ok: true, confirmed: true };
  });

  // Reset PÚBLICO del paso de correo: el propio cliente "empieza de nuevo". Existe
  // porque la confirmación del banco ya no es confiable y, en el apuro, el cliente
  // marca "ya lo cambié" cuando no fue así → el wizard dice "conectado" pero nunca
  // suena un pago (incidente jul-2026). Reusa resetEmailStep (mismo que el admin):
  // limpia change_confirmed + OTP y desliga account_id, así el wizard vuelve a pedir
  // el correo desde 0. NO destruye nada: la cuenta/alias/pagos se reencuentran por
  // order.id al rehacer (alias inmutable por orden). Auth = el order id secreto (32-hex)
  // + canOnboard, igual que el resto de /activar/:order/*.
  app.post('/activar/:order/email-reset', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!canOnboard(order)) return reply.code(402).send({ error: 'orden no pagada' });
    if (rlHit(`corrreset:${order.id}`, 60 * 60_000, 10)) {
      return reply.code(429).send({ error: 'demasiados intentos' });
    }
    const accId = resetEmailStep(order);
    logger.info({ orderId: order.id, accountId: accId }, 'paso de correo reseteado por el CLIENTE (empezar de nuevo)');
    return { ok: true, hadAccount: Boolean(accId) };
  });

  // Webhook de ForwardEmail. Distinto a Cloudflare: ForwardEmail manda el correo (parseado
  // y/o raw) y el alias va en el destinatario (recipients/to), no en un campo "alias".
  // Mismo modelo stateless: pago → speaker; OTP → captura efímera. El reenvío al cliente
  // lo hace el propio ForwardEmail (el alias reenvía a webhook + correo a la vez).
  app.post('/webhook/email-fe', async (req, reply) => {
    // Auth por firma de ForwardEmail (X-Webhook-Signature) o, de fallback, por secreto en query.
    // Para no bloquear la primera prueba, aceptamos si trae el secreto en ?key=.
    const okKey = req.query.key && req.query.key === config.EMAIL_WEBHOOK_SECRET;
    const hasSig = Boolean(req.headers['x-webhook-signature']);
    if (!okKey && !hasSig) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const body = req.body || {};
    // Inicia la medición de latencia del pipeline apenas llega el correo (fija receivedAt).
    const lat = startLatency(body);
    // ForwardEmail puede mandar: { recipients, from, subject, text, html, raw, headers } (JSON)
    // o el raw MIME. Normalizamos.
    let from = '';
    let subject = '';
    let text = '';
    let html = '';
    let recipients = [];

    try {
      if (body.raw && (!body.text && !body.subject)) {
        // viene raw MIME → parsear
        const parsed = await simpleParser(body.raw);
        from = parsed.from?.value?.[0]?.address || '';
        subject = parsed.subject || '';
        text = parsed.text || '';
        html = parsed.html || '';
        recipients = (parsed.to?.value || []).map((v) => v.address);
      } else {
        // viene parseado por ForwardEmail (formato mailparser): from/to son objetos
        // { value:[{address,name}], text, html }. Cubrimos también formatos simples.
        const f = body.from;
        from = (f && (f.value?.[0]?.address || f.address || f.text)) || (typeof f === 'string' ? f : '') || body.sender || '';
        subject = body.subject || '';
        text = body.text || body['body-plain'] || '';
        html = body.html || body['body-html'] || '';
        // recipients: ForwardEmail manda array de strings; to puede ser objeto mailparser.
        const toAddrs = body.to
          ? (body.to.value ? body.to.value.map((v) => v.address) : [typeof body.to === 'object' ? body.to.address : body.to])
          : [];
        recipients = [].concat(body.recipients || []).concat(toAddrs);
        if (body.recipient) recipients.push(body.recipient);
      }
    } catch (e) {
      logger.error({ err: e.message }, 'fe webhook parse error');
    }

    // Extraer el alias del destinatario que sea @MAIL_DOMAIN.
    const dom = '@' + config.MAIL_DOMAIN.toLowerCase();
    const target = recipients.map((r) => String(r || '').toLowerCase()).find((r) => r.endsWith(dom));
    const alias = target ? target.slice(0, target.indexOf('@')) : null;

    // Log de diagnóstico (primer correo de prueba): ver qué manda ForwardEmail.
    logger.info(
      { keys: Object.keys(body), recipients, alias, from, subject, hasRaw: Boolean(body.raw) },
      'fe webhook recibido'
    );

    if (!alias) return reply.code(200).send({ ok: true, note: 'sin alias @' + config.MAIL_DOMAIN });

    const account = getAccountByAlias(alias);
    if (!account) {
      logger.warn({ alias }, 'fe webhook: alias desconocido');
      return reply.code(200).send({ ok: true });
    }

    // Dedupe: ForwardEmail puede llamar al webhook 2 veces para el mismo correo (reintento /
    // doble entrega). Descartamos si ya procesamos este Message-ID, para no anunciar 2 veces.
    const messageId = body.messageId || body['message-id'] || null;
    if (messageId && isDuplicate(`${alias}:${messageId}`)) {
      logger.info({ alias, messageId }, 'fe webhook duplicado, ignorado');
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    // 1) ¿Es la confirmación de que el cambio de correo se completó? → cierra el onboarding.
    //    (Va primero porque tiene asunto que se parece a un pago en Bancolombia.)
    try {
      if (isChangeConfirmation({ from, subject, text, html })) {
        markChangeConfirmed(account.id);
        logger.info({ alias, accountId: account.id }, 'cambio de correo confirmado (fe)');
        return reply.code(200).send({ ok: true, changeConfirmed: true });
      }
    } catch (e) {
      logger.error({ alias, err: e.message }, 'fe change-confirm error');
    }

    // 2) ¿Es un pago de un banco CONFIABLE? (remitente de banco + SPF/DKIM ok). El filtro de
    //    sender evita inyección de pagos falsos por alguien que adivine el alias. Pago primero
    //    (delay mínimo del speaker).
    let wasPayment = false;
    try {
      if (isTrustedBankEmail(from, body)) {
        const result = parseEmail({ from: String(from).toLowerCase(), subject, text, html });
        if (result && onPaymentDetected && dropByOnlyBreb(account, result)) {
          wasPayment = true;
          logger.info({ alias, accountId: account.id, amount: result.amount, bank: result.bank },
            'only_breb: pago sin llave (transferencia directa), no se anuncia ni se registra');
        } else if (result && onPaymentDetected) {
          wasPayment = true;
          const route = pickSpeaker(account, result);
          logger.info({ alias, accountId: account.id, ...result, routedTo: route.speakerId, unrouted: route.unrouted || false }, 'payment detected (fe webhook)');
          if (route.unrouted) {
            logger.warn({ alias, accountId: account.id, amount: result.amount, key: route.key },
              'multipunto: pago NO ruteado (llave sin local), no se anuncia');
            // Persistir para "La Libreta": el cliente lo ve como "local por confirmar".
            // NO va a announceLog ni suena en ningún speaker.
            // Los EGRESOS ("Transferiste $X") NO se persisten: son plata que sale, no
            // ventas (announcePayment ya los corta en el camino ruteado). msgId permite
            // que el índice único (account_id, msg_id) dedupee reintentos de ForwardEmail.
            if (result.direction !== 'out') {
              try {
                recordPayment({
                  accountId: account.id, amount: result.amount, bank: result.bank, payer: null,
                  brebKey: route.key || result.brebKey || null,
                  speakerId: null, localName: null, unrouted: true,
                  msgId: messageId || null,
                });
              } catch (e) { logger.error({ accountId: account.id, err: e.message }, 'no se pudo persistir pago unrouted'); }
            }
          } else {
            onPaymentDetected({
              ...result,
              // Nequi/Daviplata no traen llave en el correo: heredar la del QR del local que sonó.
              brebKey: result.brebKey || route.deviceKey || null,
              accountId: account.id, speakerId: route.speakerId,
              localName: route.localName || null, messageId,
              alias, from, subject, _lat: lat,
            });
          }
        }
        // Checkout Bre-B propio: match por monto si el pago entró a la cuenta de Sonó.
        if (result) settleOwnBrebPayment(alias, result);
      } else {
        logger.info({ alias, from, knownBank: isKnownBankSender(from) }, 'fe webhook: remitente no confiable, no se procesa como pago');
      }
    } catch (e) {
      logger.error({ alias, err: e.message }, 'fe webhook payment parse error');
    }

    // 3) Si no fue pago ni confirmación, ¿es el OTP del cambio? → captura efímera.
    if (!wasPayment) {
      try { if (maybeCaptureOtp(account.id, { subject, text, html })) logger.info({ alias }, 'otp capturado (fe)'); }
      catch (e) { logger.error({ alias, err: e.message }, 'fe otp error'); }
    }

    // ForwardEmail ya reenvía al cliente (el alias tiene webhook + correo). No devolvemos forwardTo.
    return reply.code(200).send({ ok: true });
  });

  app.post('/test-voice', async (req, reply) => {
    const { amount, bank } = req.body || {};
    const playAudibleMsg = buildVoiceMessage({ amount: Number(amount) || 5000, bank });
    await publishVoice(playAudibleMsg, { amount });
    return { ok: true, playAudibleMsg };
  });

  app.get('/accounts', async (req, reply) => { if (!requireAdmin(req, reply)) return; return listAccounts(); });

  // ── La Libreta ────────────────────────────────────────────────────────────────
  // Zona de cliente solo-lectura autenticada por el order id (32-hex aleatorio).
  // REGLA DURA: /libreta/* es 100% GET. PROHIBIDO agregar endpoints mutantes o que
  // publiquen MQTT (ni getinfo bajo demanda) autenticados solo por order id.
  const LIBRETA_OFFLINE_MS = 12 * 60 * 1000;   // sin respuesta a getinfo en 12 min → offline
  const ORDER_ID_RE = /^[0-9a-f]{32}$/;

  // Rate limit (patrón Map de support-routes.js, con poda para no crecer sin tope).
  const rlBuckets = new Map();
  function rlHit(key, windowMs, max) {
    const t = Date.now();
    const arr = (rlBuckets.get(key) || []).filter((x) => t - x < windowMs);
    arr.push(t);
    rlBuckets.set(key, arr);
    if (rlBuckets.size > 5000) {
      for (const [k, v] of rlBuckets) if (!v.some((x) => t - x < 5 * 60_000)) rlBuckets.delete(k);
    }
    return arr.length > max;
  }

  /** Resuelve orden→cuenta con 404 uniforme (sin oráculo) y rate limits.
   *  Devuelve { o, acc } o null (ya respondió). Setea no-store SIEMPRE. */
  function resolveLibreta(req, reply) {
    reply.header('cache-control', 'no-store');
    const ip = req.ip;
    // anti-scan: 30 fallos (404) en 5 min → 429 por IP
    const scanArr = (rlBuckets.get(`lib404:${ip}`) || []).filter((x) => Date.now() - x < 5 * 60_000);
    if (scanArr.length >= 30) { reply.code(429).send({ error: 'demasiadas solicitudes' }); return null; }
    if (rlHit(`libip:${ip}`, 60_000, 300)) { reply.code(429).send({ error: 'demasiadas solicitudes' }); return null; }
    const id = String(req.params.order || '').toLowerCase();
    const fail = () => {                        // 404 uniforme, mismo cuerpo en TODOS los casos
      rlHit(`lib404:${ip}`, 5 * 60_000, Infinity);
      reply.code(404).send({ error: 'no encontrada' });
      return null;
    };
    if (!ORDER_ID_RE.test(id)) return fail();
    if (rlHit(`libord:${id}`, 60_000, 240)) { reply.code(429).send({ error: 'demasiadas solicitudes' }); return null; }
    const o = getOrder(id);
    if (!o || o.archived_at || !canOnboard(o)) return fail();  // archivada = kill-switch de revocación
    return { o, acc: o.account_id ? getAccount(o.account_id) : null };
  }

  // Lista blanca por pago — NUNCA payer/speaker_id/msg_id/account_id. `key` es la
  // llave Bre-B del LOCAL: es dato del propio cliente (está impresa en su QR) y es
  // lo único que separa locales homónimos o sin nombre en multipunto.
  function libRow(p) {
    return { id: p.id, amount: p.amount, bank: p.bank || null,
             local: p.local_name || null, key: p.breb_key || null,
             unrouted: Boolean(p.unrouted), at: p.at };
  }
  function libLocales(accId, acc, now) {
    const devices = listDevicesByAccount(accId);
    if (!devices.length && acc.speaker_id) {         // fallback mono-local viejo
      const d = getDevice(acc.speaker_id);
      if (d) devices.push(d);
    }
    return devices.map((d, i) => ({
      name: d.local_name || d.label || d.breb_key || `Local ${i + 1}`,
      key: d.breb_key || null,
      estado: !d.last_seen ? 'sin_datos' : (now - d.last_seen < LIBRETA_OFFLINE_MS ? 'online' : 'offline'),
      lastSeenAt: d.last_seen || null,
    }));
  }
  function libSub(acc) {
    const accOrders = listOrders().filter((x) => x.account_id === acc.id);
    const paidOrders = accOrders.filter((x) => PAID_STATES.includes(x.status));
    const main = paidOrders.sort((a, b) => (a.next_charge_at || Infinity) - (b.next_charge_at || Infinity))[0] || accOrders[0] || null;
    const state = subState(acc, main?.next_charge_at || null);
    return {
      main,
      sub: { state, readOnly: state === 'suspendida',
             daysLeft: main?.next_charge_at ? Math.ceil((main.next_charge_at - Date.now()) / DAY_MS) : null },
    };
  }

  // "Tu cuenta" del resumen: datos de la PROPIA compra del cliente (nada de infra).
  // El monto de cada cuota es EXACTAMENTE lo que cobra installments-scheduler
  // (amount_cents de la orden); las cuotas 2 y 3 caen a +30d y +60d del checkout.
  function libCuenta(accId, main, locales) {
    const cuotas = listOrders()
      .filter((o) => o.account_id === accId && PAID_STATES.includes(o.status)
        && o.plan === 'cuotas'
        && o.installments_state !== 'completado'
        && (o.installments_paid || 0) < (o.installments_total || 3))
      .map((o) => {
        const total = o.installments_total || 3;
        const pagadas = o.installments_paid || 0;
        // La 1ª cuota SIEMPRE quedó cubierta al comprar (checkout online) o al
        // recibir (contraentrega): una orden en PAID_STATES no existe sin esa
        // plata. Las COD quedan con installments_paid=0 — la próxima real es la 2ª.
        const n = Math.min(Math.max(pagadas, 1) + 1, total);
        return {
          n, pagadas, total,                             // n = la cuota que SIGUE por pagar
          monto: Math.round(CUOTA_2_3_CENTS / 100),      // $69.000 planos (el envío fue solo en la 1ª)
          // fecha programada por el scheduler; si no hay, la teórica del plan
          // (cuota 2 = orden+30d, cuota 3 = orden+60d)
          proximaAt: o.installment_next_at || (o.created_at + (n - 1) * 30 * DAY_MS),
          auto: Boolean(o.card_token),               // true = se cobra sola con la tarjeta
          estado: o.installments_state || 'al_dia',  // al_dia | en_mora | suspendido | sin_token
        };
      });
    return {
      sonos: locales.length,
      plan: main?.plan === 'cuotas' ? 'cuotas' : 'contado',
      nextChargeAt: main?.next_charge_at || null,  // renovación anual (null = sin fecha aún)
      // sin next_charge_at, el servicio va incluido hasta el año de la compra
      incluidoHasta: main ? main.created_at + 365 * DAY_MS : null,
      cuotas,
    };
  }

  // Resumen: total de hoy/ayer, mejores horas (14 días), locales, sub y 1ª página del feed.
  app.get('/libreta/:order', async (req, reply) => {
    const r = resolveLibreta(req, reply);
    if (!r) return;
    const { o, acc } = r;
    const now = Date.now();
    if (!acc) {
      return { ok: true, emailConnected: false, businessName: o.business_name || null, now,
               connectUrl: `${config.FRONTEND_BASE_URL}/activar-pro/?order=${o.id}&correo=1` };
    }
    const { main, sub } = libSub(acc);
    const locales = libLocales(acc.id, acc, now);
    const todayStart = bogotaDayStart(now);
    const today = paymentsAggregate(acc.id, todayStart, now + 1);
    const yesterday = paymentsAggregate(acc.id, todayStart - DAY_MS, todayStart);
    // Cierre de mes: mes calendario Bogotá a la fecha, comparado contra el mes
    // ANTERIOR cortado en el MISMO punto (día/hora equivalente) — comparar contra
    // el mes pasado entero haría "perder" siempre a inicio de mes.
    const monthStart = bogotaMonthStart(now);
    const prevStart = bogotaPrevMonthStart(now);
    const prevCut = Math.min(prevStart + (now - monthStart) + 1, monthStart);
    const month = paymentsAggregate(acc.id, monthStart, now + 1);
    const prevMonthToDate = paymentsAggregate(acc.id, prevStart, prevCut);
    const hours = bestHours(acc.id, now - 14 * DAY_MS, 24);
    const rows = paymentsPage(acc.id, Number.MAX_SAFE_INTEGER, 50);
    return {
      ok: true, emailConnected: true,
      businessName: main?.business_name || o.business_name || null,
      now,                                                    // reloj del server (la UI calcula offset)
      today:     { total: today.total, count: today.n, startAt: todayStart },
      yesterday: { total: yesterday.total, count: yesterday.n },
      month:     { total: month.total, count: month.n, startAt: monthStart },
      prevMonthToDate: { total: prevMonthToDate.total, count: prevMonthToDate.n },
      bestHours: hours.map((h) => ({ hour: h.hour, count: h.n, total: h.total })),
      locales, multi: locales.length > 1, sub: sub,
      cuenta: libCuenta(acc.id, main, locales),
      payments: rows.map(libRow),
      nextBefore: rows.length === 50 ? rows[rows.length - 1].id : null,
      latestId: rows.length ? rows[0].id : 0,
    };
  });

  // Feed: polling en vivo (?after=) e historial hacia atrás (?before=).
  app.get('/libreta/:order/feed', async (req, reply) => {
    const r = resolveLibreta(req, reply);
    if (!r) return;
    const { acc } = r;
    const now = Date.now();
    if (!acc) return { ok: true, emailConnected: false, payments: [], now };

    // Filtro por fecha: ?day=YYYY-MM-DD (día calendario Bogotá) → ventas de ese día
    // + su cierre {total,count}, paginable DENTRO del día con &before=. Día que no
    // es una fecha real → 404 uniforme (la UI solo manda días válidos).
    if (req.query.day !== undefined) {
      const dayStart = bogotaDayStartFromKey(req.query.day);
      if (dayStart === null) return reply.code(404).send({ error: 'no encontrada' });
      const dayEnd = dayStart + DAY_MS;
      const before = Number.parseInt(req.query.before, 10);
      const cursor = Number.isFinite(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
      const rows = paymentsPageRange(acc.id, dayStart, dayEnd, cursor, 50);
      const agg = paymentsAggregate(acc.id, dayStart, dayEnd);
      return {
        ok: true, now, day: String(req.query.day),
        dayTotal: { total: agg.total, count: agg.n, startAt: dayStart },
        payments: rows.map(libRow),
        nextBefore: rows.length === 50 ? rows[rows.length - 1].id : null,
      };
    }

    const before = Number.parseInt(req.query.before, 10);
    if (Number.isFinite(before) && before > 0) {              // historial hacia atrás
      let limit = Number.parseInt(req.query.limit, 10);
      limit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 30;  // clamp, nunca 400
      const rows = paymentsPage(acc.id, before, limit);
      return { ok: true, now, payments: rows.map(libRow),
               nextBefore: rows.length === limit ? rows[rows.length - 1].id : null };
    }

    const after = Math.max(Number.parseInt(req.query.after, 10) || 0, 0);  // polling en vivo
    let rows = paymentsAfter(acc.id, after, 51);
    const gap = rows.length === 51;                            // >50 nuevos → cliente recarga resumen
    if (gap) rows = rows.slice(0, 50);
    const todayStart = bogotaDayStart(now);
    const today = paymentsAggregate(acc.id, todayStart, now + 1);
    const monthStart = bogotaMonthStart(now);
    const month = paymentsAggregate(acc.id, monthStart, now + 1);
    return {
      ok: true, now, gap,
      payments: rows.map(libRow),
      latestId: rows.length ? rows[0].id : after,
      today: { total: today.total, count: today.n, startAt: todayStart },
      month: { total: month.total, count: month.n, startAt: monthStart },
      locales: libLocales(acc.id, acc, now),
      sub: libSub(acc).sub,
    };
  });

  // "Acceso a mi Libreta": el cliente que no tiene el enlace mete su celular y, si
  // coincide con una orden, se le REENVÍA el link por WhatsApp AL número registrado.
  // El número NUNCA sirve para entrar directo ni el link se muestra en pantalla
  // (cualquiera puede saber tu teléfono; solo el dueño del WhatsApp recibe el link).
  // Respuesta SIEMPRE uniforme {ok:true}: sin oráculo de qué números existen.
  // (Vive FUERA de /libreta/* a propósito: esa ruta sigue siendo 100% GET.)
  app.post('/libreta-acceso', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const ip = req.ip;
    if (rlHit(`libacc:${ip}`, 10 * 60_000, 5)) {
      return reply.code(429).send({ error: 'demasiadas solicitudes' });
    }
    const phone = normalizePhoneCO((req.body || {}).phone);
    if (phone) {
      // por teléfono: máx 2 reenvíos/hora (el mensajero de WhatsApp no es spam)
      if (rlHit(`libaccph:${phone}`, 60 * 60_000, 2)) {
        return reply.code(429).send({ error: 'demasiadas solicitudes' });
      }
      // La orden pagada MÁS RECIENTE de ese teléfono (cualquier orden abre toda la
      // cuenta). Archivadas jamás: archivar = kill-switch también de este reenvío.
      const match = listOrders()
        .filter((o) => !o.archived_at && PAID_STATES.includes(o.status)
          && normalizePhoneCO(o.phone) === phone)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
      if (match) {
        enqueueWhatsAppForce(match, 'libreta');
        logger.info({ orderId: match.id }, 'libreta-acceso: enlace reenviado por WhatsApp');
      } else {
        logger.info({ phone: phone.slice(-4) }, 'libreta-acceso: teléfono sin orden, no se encola');
      }
    }
    return { ok: true }; // mismo body haya o no match (sin oráculo)
  });

  // "Conectar mi correo" (paso 1 del manual, autogestión): el cliente escribe su
  // celular y recibe el enlace del wizard (&correo=1) para conectar/RECONECTAR el
  // correo. A diferencia de /libreta-acceso acá no se reenvía por WhatsApp: ese canal
  // depende del agente de la PC / del webhook de la transportadora, y este flujo existe
  // justamente para cuando fallan (decisión 17-jul-2026).
  //   • NO afirmamos "conectado": el sistema NO puede saber de forma fiable si el cliente
  //     terminó el cambio en el banco. `change_confirmed` lo pone el botón manual "ya lo
  //     cambié", que el cliente toca en su apuro sin haber terminado → NO es prueba. La
  //     ÚNICA señal 100% confiable es que ya haya llegado un PAGO real por esa cuenta.
  //     Por eso devolvemos `working` = ¿ya recibió al menos un pago? (provable). Si no,
  //     ni aseguramos ni negamos; solo ofrecemos conectar/reconectar (decisión 22-jul-2026).
  //   • `connectUrl` + `order` van SIEMPRE (working o no): el cliente debe poder rehacerlo
  //     las veces que quiera. Apuntan a la orden que YA tiene la cuenta, para que el wizard
  //     reuse el MISMO alias (inmutable por orden) — reconectar nunca genera uno nuevo, así
  //     el correo que el cliente ya puso en su banco sigue sirviendo. `order` explícito deja
  //     al front reiniciar (email-reset) antes de abrir el wizard, cayendo directo en el
  //     flujo de rehacer sin la pantalla intermedia "¡Correo conectado!".
  // Rate limits por IP y por teléfono.
  app.post('/correo-acceso', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const ip = req.ip;
    if (rlHit(`corracc:${ip}`, 10 * 60_000, 30)) {
      return reply.code(429).send({ error: 'demasiadas solicitudes' });
    }
    const phone = normalizePhoneCO((req.body || {}).phone);
    if (!phone) return { ok: true, found: false };
    if (rlHit(`corraccph:${phone}`, 60 * 60_000, 10)) {
      return reply.code(429).send({ error: 'demasiadas solicitudes' });
    }
    // Órdenes del teléfono que pueden onboardear (canOnboard: pagadas Y contraentrega
    // — el cliente COD ya tiene el speaker en la mano). Archivadas jamás (kill-switch).
    const propias = listOrders().filter((o) => !o.archived_at && canOnboard(o)
      && normalizePhoneCO(o.phone) === phone);
    if (!propias.length) {
      logger.info({ phone: phone.slice(-4) }, 'correo-acceso: teléfono sin orden');
      return { ok: true, found: false };
    }
    // ¿Ya FUNCIONA? = llegó al menos un pago real por la cuenta. Única prueba fiable;
    // NO usamos change_confirmed (lo marca a mano el cliente, sin garantía de que sirvió).
    const workingFor = (o) => (o.account_id ? paymentsFor(o.account_id, 1).length > 0 : false);
    // Enrutar SIEMPRE al MISMO alias: preferimos la orden que ya tiene cuenta (su wizard
    // reusa el alias inmutable); si ninguna, la más reciente. El onboarding es por CLIENTE,
    // así que con órdenes gemelas (checkout reintentado) la que tiene la cuenta manda.
    const conAccount = propias.find((o) => o.account_id && getAccount(o.account_id));
    const target = conAccount
      || propias.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
    const working = conAccount ? workingFor(conAccount) : false;
    logger.info({ orderId: target.id, working }, 'correo-acceso: enlace mostrado');
    return { ok: true, found: true, working, order: target.id,
             businessName: target.business_name || null,
             connectUrl: `${config.FRONTEND_BASE_URL}/activar-pro/?order=${target.id}&correo=1` };
  });

  // Bot de soporte (chat público + admin + web push).
  registerSupportRoutes(app);

  // Envíos Skydropx (despachar el speaker de una orden + guía PDF).
  registerSkydropxRoutes(app);

  if (listen) {
    app.listen({ port: config.HTTP_PORT, host: config.HTTP_HOST })
      .then(() => logger.info({ port: config.HTTP_PORT }, 'http server listening'))
      .catch(e => { logger.error({ err: e.message }, 'http listen fail'); process.exit(1); });
  }

  return app;
}
