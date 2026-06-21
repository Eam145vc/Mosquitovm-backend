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
  updateAccountHistory, updateAccountWatch, setAccountForward, markChangeConfirmed,
  paymentsFor, subState, setSubStatus,
  saveInboxMail, listInbox, getInboxMail, markInboxSeen, deleteInboxMail, unseenInboxCount,
} from './storage.js';
import { parseEmail } from './parsers/index.js';
import { simpleParser } from 'mailparser';
import { generateAlias, createClientAlias } from './forwardemail.js';
import { maybeCaptureOtp, readOtp } from './otp-capture.js';
import { isDuplicate } from './dedupe.js';
import { isChangeConfirmation } from './change-confirm.js';
import { isTrustedBankEmail, isKnownBankSender } from './sender-filter.js';
import { forwardPayment, paymentRedirectUrl, fetchPayment, paymentIdFromWebhook, createPreference } from './mercadopago.js';
import { createStripeCheckout, fetchStripeSession } from './stripe.js';
import { generatePaymentLink, chargeCard, chargePse, chargeBreb, chargeCash, getResource, fetchEfiTransaction, isValidEfiWebhook, parseEfiWebhook } from './efipay.js';
import * as announceLog from './announce-log.js';
import { publishVoice, publishCommand } from './mqtt-publisher.js';
import { buildVoiceMessage } from './amount-to-wavs.js';
import { startLatency, markVoicePublished } from './latency.js';
import { getStats as getLatencyStats } from './latency-store.js';
import { handlePubSubPush } from './pubsub-handler.js';
import { watchInbox } from './gmail-api.js';
import { registerSupportRoutes } from './support/support-routes.js';
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

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'application/pdf': 'pdf',
};

/** Vista publica de una orden (sin datos sensibles), con el paso actual del wizard.
 *  El envio se recoge ANTES de pagar (checkout), asi que el post-pago son 2 pasos:
 *  1=correo, 2=qr, 3=listo. */
function orderView(o) {
  let step = 1;
  if (o.account_id) step = 2;
  if (o.account_id && o.qr_path) step = 3;
  return {
    order: o.id,
    paid: isPaid(o),
    status: o.status,
    step,
    emailMethod: o.email_method || null,
    hasEmail: Boolean(o.account_id),
    hasQr: Boolean(o.qr_path),
    hasShipping: Boolean(o.business_name),
    payerEmail: o.mp_payer_email || null,  // para pre-rellenar el correo del método redirect
    customerEmail: o.customer_email || null, // correo del checkout, para prellenar el onboarding
  };
}

export function startHttp(onAccountAdded, onPaymentDetected, onSubStatusChange) {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 }); // 10MB para correos de ForwardEmail

  app.register(fastifyCors, {
    origin: [config.FRONTEND_BASE_URL],
    methods: ['GET', 'POST', 'PATCH'],
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
  // anual = $299.000 un solo pago con dispositivo incluido · mensual = $89.000 hoy
  // por el dispositivo (la mensualidad de $30.000 va por suscripción aparte).
  // "test" = orden de diagnóstico de la página /test-mp ($5.000, va directo al
  // Brick de MercadoPago sin Stripe ni Checkout Pro). El admin la ve como TEST.
  // mensual = 1er mes $29.900 + envío $15.000 = $44.900 hoy (dispositivo gratis).
  // anual = $199.000 (dispositivo + envío incluidos). test = $5.000 diagnóstico.
  const PLAN_PRICES_CENTS = { anual: 19_900_000, mensual: 4_490_000, test: 500_000 };

  // Paso 1: crea la orden con los datos de envío. Devuelve el monto (pesos) y la public key
  // para que el front renderice el formulario de tarjeta (Bricks) embebido.
  app.post('/checkout/create', async (req, reply) => {
    if (!config.hasEfipay && !config.hasStripe && !config.hasMp) {
      return reply.code(503).send({ error: 'checkout no configurado' });
    }
    const { business_name, bank, address, city, phone, email, plan } = req.body || {};
    if (!business_name || !address || !phone) {
      return reply.code(400).send({ error: 'faltan nombre, direccion o telefono' });
    }
    const amountCents = PLAN_PRICES_CENTS[plan] ?? PLAN_PRICES_CENTS.anual;
    const orderId = createOrder({ amountCents });            // external_reference = orderId
    updateOrder(orderId, {
      business_name, bank: bank || null, address, city: city || null, phone,
      customer_email: email || null,
    });
    logger.info({ orderId, plan: plan || 'anual', amountCents, business_name }, 'orden creada');
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
      // No marcamos pagado acá: PSE/Bre-B/cash confirman por webhook. Solo si ya aprobó.
      if (result.approved) {
        const nextCharge = Date.now() + 365 * 24 * 3600 * 1000;
        updateOrder(orderId, {
          status: 'pendiente_qr', wompi_txn_id: String(result.transactionId || ''),
          mp_payer_email: payer.email, next_charge_at: nextCharge,
        });
      }
      logger.info({ orderId, method, status: result.status, hasRedirect: Boolean(result.redirect), hasQr: Boolean(result.qr) }, 'efipay alt iniciado');
      // Bre-B con QR → el front lo muestra embebido (no redirige). PSE/cash → redirect.
      return { status: result.status, approved: result.approved, redirect: result.redirect, qr: result.qr || null };
    } catch (e) {
      logger.error({ orderId, method, err: e.message }, 'efipay alt failed');
      return reply.code(502).send({ error: 'No pudimos iniciar el pago. Probá de nuevo.', detail: e.message });
    }
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
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
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
    if (!isPaid(order)) return reply.code(402).send({ error: 'orden no pagada' });

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
    if (!isPaid(order)) return reply.code(402).send({ error: 'orden no pagada' });

    const forwardTo = String((req.body || {}).email || '').trim().toLowerCase();
    if (!forwardTo || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(forwardTo)) {
      return reply.code(400).send({ error: 'Poné un correo válido.' });
    }

    const accountId = order.account_id || order.id;
    const alias = generateAlias(forwardTo);

    // Crear el alias en ForwardEmail (recipients = correo del cliente + webhook del speaker).
    const fe = await createClientAlias({ name: alias, forwardTo });
    if (!fe.ok && !fe.skipped) {
      logger.error({ orderId: order.id, alias, err: fe.error }, 'email-redirect: fallo crear alias FE');
      return reply.code(502).send({ error: 'No pudimos generar tu correo. Probá de nuevo.' });
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

  app.post('/activar/:order/qr', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!isPaid(order)) return reply.code(402).send({ error: 'orden no pagada' });

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file' });
    const ext = MIME_EXT[file.mimetype];
    if (!ext) return reply.code(415).send({ error: 'formato no soportado (usa png/jpg/webp/pdf)' });

    const buf = await file.toBuffer();
    if (buf.length > 5 * 1024 * 1024) return reply.code(413).send({ error: 'archivo muy grande' });

    const filename = `${order.id}.${ext}`;
    fs.writeFileSync(path.join(QR_DIR, filename), buf);

    const patch = { qr_path: filename, qr_mime: file.mimetype };
    if (order.business_name) patch.status = 'ready_to_ship';
    updateOrder(order.id, patch);
    logger.info({ orderId: order.id, bytes: buf.length }, 'qr subido');
    return { ok: true };
  });

  app.post('/activar/:order/shipping', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });
    if (!isPaid(order)) return reply.code(402).send({ error: 'orden no pagada' });

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

  app.get('/admin/orders', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const byOrder = new Map(listDevices().filter(d => d.order_id).map(d => [d.order_id, d.spkr_id]));
    return listOrders().map(o => ({
      id: o.id, status: o.status, business_name: o.business_name, bank: o.bank,
      address: o.address, city: o.city, phone: o.phone, email_method: o.email_method,
      account_id: o.account_id, hasQr: Boolean(o.qr_path), created_at: o.created_at,
      next_charge_at: o.next_charge_at, mp_payer_email: o.mp_payer_email,
      speaker_id: byOrder.get(o.id) || null,
    }));
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
    logger.info({ orderId: o.id, spkr_id, account: o.account_id || '(pendiente)' }, 'device asignado a la orden');
    return { ok: true, spkr_id, account_id: o.account_id || null };
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
  app.get('/admin/latency', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    // Resuelve accountId → nombre del comercio (business_name de su orden, o el email).
    const resolveName = (accountId) => {
      const ord = listOrders().find((o) => o.account_id === accountId && o.business_name);
      if (ord) return ord.business_name;
      const acc = getAccount(accountId);
      return acc ? acc.email : null;
    };
    return getLatencyStats(resolveName);
  });

  // ── Buzón (catch-all): correo que entra al MX a un alias DESCONOCIDO ──
  // (los de clientes conocidos NO se guardan acá; van al buzón de cada cliente).
  // Reemplaza el viejo reenvío del catch-all al correo personal. Agrupado por alias.
  app.get('/admin/inbox', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = listInbox({ limit: 200 }).map((m) => ({
      id: m.id,
      alias: m.alias,
      from: m.from_addr,
      subject: m.subject,
      isPayment: Boolean(m.is_payment),
      seen: Boolean(m.seen),
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
      id: m.id, alias: m.alias,
      from: m.from_addr, subject: m.subject, text: m.text, html: m.html,
      isPayment: Boolean(m.is_payment), at: m.at,
    };
  });

  app.delete('/admin/inbox/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { ok: deleteInboxMail(Number(req.params.id)) };
  });

  app.get('/admin/clients/:id/detail', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    const summary = clientSummary(acc);
    const orders = listOrders().filter(o => o.account_id === acc.id)
      .map(o => ({ id: o.id, status: o.status, business_name: o.business_name, bank: o.bank,
        next_charge_at: o.next_charge_at, hasQr: Boolean(o.qr_path), created_at: o.created_at }));
    const speakersList = listDevices().filter(d => (d.order_id && orders.some(o => o.id === d.order_id)) || (acc.speaker_id && d.spkr_id === acc.speaker_id))
      .map(d => ({ spkr_id: d.spkr_id, mac: d.mac, model: d.model, status: d.status,
        last_seen: d.last_seen, battery: d.battery, ssid: d.ssid }));
    return {
      ...summary,
      email_method: acc.auth_type === 'imap' ? 'imap' : (acc.alias ? 'redirect' : (acc.oauth_provider || 'gmail')),
      change_confirmed: Boolean(acc.change_confirmed),
      grace_until: acc.grace_until || null,
      suspended_at: acc.suspended_at || null,
      orders,
      speakers_list: speakersList,
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
    return listDevices().map((d) => ({ ...d, battery: battPct(d.battery) }));
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

    const { alias, from = '', subject = '', text = '', html = '' } = req.body || {};
    if (!alias) return reply.code(400).send({ error: 'alias requerido' });

    const account = getAccountByAlias(String(alias).toLowerCase());
    if (!account) {
      // Alias desconocido: no reenviamos a ciegas (no sabemos a quién), pero SÍ lo
      // guardamos en el buzón (catch-all) para verlo en /admin → Buzón. Antes esto
      // se reenviaba al correo personal; ahora queda en el panel.
      try { saveInboxMail({ alias, accountId: null, from, subject, text, html, isPayment: false }); }
      catch (e) { logger.error({ alias, err: e.message }, 'inbox save (desconocido) error'); }
      logger.warn({ alias }, 'email webhook: alias desconocido (guardado en buzón)');
      return { ok: true, forwardTo: null };
    }

    // ¿Es una notificación de pago? Parseamos SOLO para extraer monto+banco.
    // PRIORIDAD: el pago va PRIMERO (hacer sonar el IoT con el mínimo delay).
    let wasPayment = false;
    try {
      const result = parseEmail({ from: String(from).toLowerCase(), subject, text, html });
      if (result && onPaymentDetected) {
        wasPayment = true;
        logger.info({ alias, accountId: account.id, ...result }, 'payment detected (email webhook)');
        onPaymentDetected({
          ...result,
          accountId: account.id,
          speakerId: account.speaker_id,
          from, subject,
          _lat: lat,
        });
      }
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

  // Onboarding Fase 3: el frontend hace polling acá para (a) mostrar el OTP del banco y
  // (b) saber si el cambio ya se confirmó (el banco mandó el "correo cambiado con éxito")
  // para cerrar el onboarding automático. Efímero/scopeado por order id (no adivinable).
  app.get('/activar/:order/otp', async (req, reply) => {
    const order = getOrder(req.params.order);
    if (!order || !order.account_id) return { code: null, confirmed: false };
    const otp = readOtp(order.account_id);
    const acc = getAccount(order.account_id);
    return { code: otp ? otp.code : null, confirmed: Boolean(acc && acc.change_confirmed) };
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
        if (result && onPaymentDetected) {
          wasPayment = true;
          logger.info({ alias, accountId: account.id, ...result }, 'payment detected (fe webhook)');
          onPaymentDetected({ ...result, accountId: account.id, speakerId: account.speaker_id, from, subject, _lat: lat });
        }
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

  app.get('/accounts', async () => listAccounts());

  // Bot de soporte (chat público + admin + web push).
  registerSupportRoutes(app);

  app.listen({ port: config.HTTP_PORT, host: config.HTTP_HOST })
    .then(() => logger.info({ port: config.HTTP_PORT }, 'http server listening'))
    .catch(e => { logger.error({ err: e.message }, 'http listen fail'); process.exit(1); });

  return app;
}
