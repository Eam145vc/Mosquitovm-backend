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
  updateAccountHistory, updateAccountWatch, setAccountForward, findAccountByForward, markChangeConfirmed,
  paymentsFor, subState, setSubStatus,
  saveInboxMail, listInbox, getInboxMail, markInboxSeen, deleteInboxMail, unseenInboxCount,
  markInboxReplied, saveOutboundMail,
} from './storage.js';
import { decodeBrebImage, normalizeKey } from './breb-qr.js';
import { parseEmail } from './parsers/index.js';
import { simpleParser } from 'mailparser';
import { generateAlias, createClientAlias } from './forwardemail.js';
import { maybeCaptureOtp, readOtp } from './otp-capture.js';
import { isDuplicate } from './dedupe.js';
import { isChangeConfirmation } from './change-confirm.js';
import { isTrustedBankEmail, isKnownBankSender } from './sender-filter.js';
import { forwardPayment, paymentRedirectUrl, fetchPayment, paymentIdFromWebhook, createPreference } from './mercadopago.js';
import { createStripeCheckout, fetchStripeSession } from './stripe.js';
import { generatePaymentLink, chargeCard, chargePse, chargeBreb, chargeCash, getResource, fetchEfiTransaction, fetchEfiStatus, isValidEfiWebhook, parseEfiWebhook, tokenizeCard } from './efipay.js';
import * as announceLog from './announce-log.js';
import { sendActivationEmail } from './activation-email.js';
import { publishVoice, publishCommand } from './mqtt-publisher.js';
import { buildVoiceMessage } from './amount-to-wavs.js';
import { startLatency, markVoicePublished } from './latency.js';
import { getStats as getLatencyStats } from './latency-store.js';
import { handlePubSubPush } from './pubsub-handler.js';
import { watchInbox } from './gmail-api.js';
import { registerSupportRoutes } from './support/support-routes.js';
import { registerSkydropxRoutes } from './skydropx-routes.js';
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
 *  1=correo, 2=qr, 3=listo. */
function orderView(o) {
  // El correo cuenta como LISTO solo si hay PRUEBA de que el reenvío funciona: o el banco
  // confirmó el cambio (change_confirmed), o ya llegó al menos un pago por esa cuenta.
  // Tener account_id NO basta: el cliente pudo poner su correo y crear la cuenta, pero si
  // no completó el cambio en el banco, debe seguir en el paso 1 (si no, saltaría al QR sin
  // que los pagos lleguen de verdad).
  const acc = o.account_id ? getAccount(o.account_id) : null;
  const hasReceivedPayment = o.account_id ? paymentsFor(o.account_id, 1).length > 0 : false;
  const emailReady = Boolean(acc && (acc.change_confirmed || hasReceivedPayment));
  let step = 1;
  if (emailReady) step = 2;
  if (emailReady && o.qr_path) step = 3;
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
    delivery: o.delivery || 'online', // 'online' | 'contraentrega' → el front decide cuándo reportar el Purchase a los pixels
  };
}

export function startHttp(onAccountAdded, onPaymentDetected, onSubStatusChange) {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 }); // 10MB para correos de ForwardEmail

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
  const pickSpeaker = (account, payment) => {
    const devices = listDevicesByAccount(account.id);
    if (devices.length <= 1) {
      // un solo local: suena en su speaker (el de la cuenta o el único device).
      return { speakerId: account.speaker_id || (devices[0] && devices[0].spkr_id) || null };
    }
    // multipunto: rutear por llave.
    const key = payment.brebKey ? normalizeKey(payment.brebKey) : null;
    if (key) {
      const dev = findDeviceByKey(account.id, key);
      if (dev) return { speakerId: dev.spkr_id, localName: dev.local_name };
    }
    // sin llave parseable o llave que no coincide con ningún local → NO suena + aviso.
    return { speakerId: null, unrouted: true, key };
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

  // Paso 1: crea la orden con los datos de envío. Devuelve el monto (pesos) y la public key
  // para que el front renderice el formulario de tarjeta (Bricks) embebido.
  app.post('/checkout/create', async (req, reply) => {
    if (!config.hasEfipay && !config.hasStripe && !config.hasMp) {
      return reply.code(503).send({ error: 'checkout no configurado' });
    }
    const { business_name, bank, address, city, phone, email, plan, delivery } = req.body || {};
    if (!business_name || !address || !phone) {
      return reply.code(400).send({ error: 'faltan nombre, direccion o telefono' });
    }
    const planNorm = plan === 'cuotas' ? 'cuotas' : 'contado';
    const esContraentrega = delivery === 'contraentrega';
    const deliveryNorm = esContraentrega ? 'contraentrega' : 'online';
    // El recargo de contraentrega ($5.000) se suma en ambos planes.
    const amountCents = (PLAN_PRICES_CENTS[plan] ?? PLAN_PRICES_CENTS.contado)
      + (esContraentrega ? RECARGO_CONTRAENTREGA_CENTS : 0);
    const orderId = createOrder({ amountCents });            // external_reference = orderId
    updateOrder(orderId, {
      business_name, bank: bank || null, address, city: city || null, phone,
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
        // Correo con el link de activación (red de seguridad si cierra la pantalla).
        sendActivationEmail(getOrder(orderId)).catch(() => {});

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
        sendActivationEmail(getOrder(orderId)).catch(() => {});
      }
      logger.info({ orderId, method, status: result.status, paymentId: result.paymentId, hasRedirect: Boolean(result.redirect), hasQr: Boolean(result.qr) }, 'efipay alt iniciado');
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
          sendActivationEmail(getOrder(order.id)).catch(() => {});
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
          sendActivationEmail(o).catch(() => {});
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
  // Devuelve { hasQr, brebKey, brebKeyType } — brebKey=null si no se pudo decodificar.
  async function processQrUpload(order, buf, mimetype, ext) {
    const filename = `${order.id}.${ext}`;
    fs.writeFileSync(path.join(QR_DIR, filename), buf);

    const patch = { qr_path: filename, qr_mime: mimetype };
    if (order.business_name) patch.status = 'ready_to_ship';
    updateOrder(order.id, patch);

    let brebKey = null, brebKeyType = null;
    // Multipunto: decodificar el QR Bre-B para extraer la LLAVE del local y guardarla en
    // el device de esta orden (sirve para rutear los pagos al speaker correcto). Solo
    // imágenes (los PDF no se decodifican acá). Si falla, NO rompemos la subida del QR.
    if (mimetype.startsWith('image/')) {
      try {
        const decoded = await decodeBrebImage(buf);
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
        } else {
          logger.warn({ orderId: order.id }, 'multipunto: QR sin llave ruteable (no se pudo asociar)');
        }
      } catch (e) {
        logger.warn({ orderId: order.id, err: e.message }, 'multipunto: fallo al decodificar el QR (la subida sigue OK)');
      }
    }
    return { hasQr: true, brebKey, brebKeyType };
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

    await processQrUpload(order, buf, file.mimetype, ext);
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

  // Cambiar manualmente el estado de despacho de una orden (control del admin).
  // Estados válidos: 'ready_to_ship' (Por despachar) | 'shipped' (Enviado).
  // Sincroniza el device asociado para que el derivador del panel sea consistente.
  app.post('/admin/orders/:order/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const o = getOrder(req.params.order);
    if (!o) return reply.code(404).send({ error: 'orden no encontrada' });
    const { status } = req.body || {};
    const VALID = ['ready_to_ship', 'shipped'];
    if (!VALID.includes(status)) return reply.code(400).send({ error: 'estado inválido' });
    updateOrder(o.id, { status });
    const dev = listDevices().find(d => d.order_id === o.id);
    if (dev) setDeviceStatus(dev.spkr_id, status === 'shipped' ? 'enviado' : 'provisionado');
    logger.info({ orderId: o.id, status }, 'estado de despacho cambiado (admin)');
    return { ok: true, status };
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
    return getLatencyStats(resolveName, { from, to, all });
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

  app.get('/admin/clients/:id/detail', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const acc = getAccount(req.params.id);
    if (!acc) return reply.code(404).send({ error: 'cliente no encontrado' });
    const summary = clientSummary(acc);
    const accOrders = listOrders().filter(o => o.account_id === acc.id);
    const orders = accOrders
      .map(o => ({ id: o.id, status: o.status, business_name: o.business_name, bank: o.bank,
        next_charge_at: o.next_charge_at, hasQr: Boolean(o.qr_path), created_at: o.created_at,
        breb_key: o.breb_key || null, local_name: o.local_name || null }));
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

    // ¿Es una notificación de pago? Parseamos SOLO para extraer monto+banco.
    // PRIORIDAD: el pago va PRIMERO (hacer sonar el IoT con el mínimo delay).
    let wasPayment = false;
    try {
      const result = parseEmail({ from: String(from).toLowerCase(), subject, text, html });
      if (result && onPaymentDetected) {
        wasPayment = true;
        const route = pickSpeaker(account, result);
        logger.info({ alias, accountId: account.id, ...result, routedTo: route.speakerId, unrouted: route.unrouted || false }, 'payment detected (email webhook)');
        if (route.unrouted) {
          // Multipunto: no se pudo determinar el local (llave desconocida) → NO suena.
          // NO se guarda en el buzón (ensuciaba el inbox con un aviso por pago); queda solo
          // en el log. Cuando exista el panel del usuario, se mostrarán desde el historial.
          logger.warn({ alias, accountId: account.id, amount: result.amount, key: route.key }, 'multipunto: pago NO ruteado (llave sin local), no se anuncia');
        } else {
          onPaymentDetected({
            ...result,
            accountId: account.id,
            speakerId: route.speakerId,
            alias,
            from, subject,
            _lat: lat,
          });
        }
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
          const route = pickSpeaker(account, result);
          logger.info({ alias, accountId: account.id, ...result, routedTo: route.speakerId, unrouted: route.unrouted || false }, 'payment detected (fe webhook)');
          if (route.unrouted) {
            // NO se guarda en el buzón (ensuciaba el inbox); solo log. El panel del
            // usuario los mostrará desde el historial cuando exista.
            logger.warn({ alias, accountId: account.id, amount: result.amount, key: route.key }, 'multipunto: pago NO ruteado (llave sin local), no se anuncia');
          } else {
            onPaymentDetected({ ...result, accountId: account.id, speakerId: route.speakerId, alias, from, subject, _lat: lat });
          }
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

  app.get('/accounts', async (req, reply) => { if (!requireAdmin(req, reply)) return; return listAccounts(); });

  // Bot de soporte (chat público + admin + web push).
  registerSupportRoutes(app);

  // Envíos Skydropx (despachar el speaker de una orden + guía PDF).
  registerSkydropxRoutes(app);

  app.listen({ port: config.HTTP_PORT, host: config.HTTP_HOST })
    .then(() => logger.info({ port: config.HTTP_PORT }, 'http server listening'))
    .catch(e => { logger.error({ err: e.message }, 'http listen fail'); process.exit(1); });

  return app;
}
