// Configuracion del backend, validada con Zod.
import { z } from 'zod';

const ConfigSchema = z.object({
  // ---- MQTT ----
  MQTT_URL: z.string().min(1),
  MQTT_USERNAME: z.string().min(1),
  MQTT_PASSWORD: z.string().min(1),

  // ---- IMAP server ----
  IMAP_HOST: z.string().default('imap.gmail.com'),
  IMAP_PORT: z.coerce.number().int().default(993),

  // ---- OAuth2 Google ----
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:3000/auth/callback'),

  // ---- OAuth2 Microsoft (Outlook/Hotmail/Live/Office365) ----
  MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_REDIRECT_URI: z.string().url().default('http://localhost:3000/auth/microsoft/callback'),
  // 'common' = cuentas personales + trabajo. 'consumers' = solo personales.
  MICROSOFT_TENANT: z.string().default('common'),

  // ---- Storage encryption ----
  // 32 bytes base64 para AES-256-GCM. Generalo con: openssl rand -base64 32
  ENCRYPTION_KEY: z.string().min(32).optional(),
  DB_PATH: z.string().default('./_data/db.sqlite'),

  // ---- HTTP server ----
  HTTP_PORT: z.coerce.number().int().default(3000),
  HTTP_HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  // ---- Default speaker (modo single-tenant para pruebas) ----
  // En multi-tenant cada cliente tiene su speaker; este es para el single-tenant.
  SPEAKER_DEVICE_ID: z.string().default('spkr-001'),

  // ---- Gmail API / Pub/Sub ----
  // topicName completo: projects/PROJECT_ID/topics/TOPIC_NAME
  GMAIL_PUBSUB_TOPIC: z.string().default(''),
  // Token compartido para verificar que las requests al webhook vienen de Pub/Sub
  PUBSUB_VERIFICATION_TOKEN: z.string().default(''),

  // ---- Allowlist de remitentes (csv) ----
  ALLOWED_SENDERS: z.string().default(''),

  // ---- Checkout MercadoPago (Payment Brick in-web) ----
  // TEST-... para pruebas (sin dinero real) | APP_USR-... para producción.
  MP_ACCESS_TOKEN: z.string().default(''),
  MP_PUBLIC_KEY: z.string().default(''),

  // ---- Checkout Stripe (tarjetas, embebido en sono.lat) ----
  // Mientras MercadoPago no procese por API. sk_live/rk_live con permiso de
  // Checkout Sessions; la public key la usa el front para montar el embebido.
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_PUBLIC_KEY: z.string().default(''),
  // Servicio anual (dispositivo gratis). 200.000 COP = 20.000.000 centavos.
  PRICE_COP_CENTS: z.coerce.number().int().default(20000000),

  // ---- Checkout EfiPay (pasarela colombiana, comercio 5498) ----
  // Token del panel (Desarrollador API key). Pago por link (todos los métodos) +
  // suscripción recurrente por tarjeta. Host: https://sag.efipay.co
  EFIPAY_TOKEN: z.string().default(''),
  // ID de sucursal del comercio (Principal = 6055).
  EFIPAY_OFFICE: z.coerce.number().int().default(6055),
  // Token Webhooks del panel, para validar las notificaciones entrantes.
  EFIPAY_WEBHOOK_TOKEN: z.string().default(''),

  // ---- Frontend (sono-web) para redirects del wizard ----
  FRONTEND_BASE_URL: z.string().url().default('http://localhost:3000'),

  // ---- Admin (fulfillment / inventario) ----
  // Token interno (Bearer) que usan los endpoints /admin/*. El front lo obtiene
  // tras loguearse con ADMIN_USER/ADMIN_PASS en /admin/login; nunca se escribe a mano.
  ADMIN_TOKEN: z.string().default(''),
  ADMIN_USER: z.string().default(''),
  ADMIN_PASS: z.string().default(''),

  // ---- Correo redirigido (Cloudflare Email Worker → webhook) ----
  // Secreto compartido con el Worker para autenticar el POST a /webhook/email.
  // También autentica los endpoints /wa/pending y /wa/sent que consume el agente
  // de WhatsApp de la PC del dueño (header x-sono-secret). NO requiere secret nuevo.
  EMAIL_WEBHOOK_SECRET: z.string().default(''),
  // Dominio de los alias (ej. 'sono.lat' → alias juan-abc@sono.lat).
  MAIL_DOMAIN: z.string().default('sono.lat'),
  // Subdominio (MX = Forward Email) donde se crean los aliases para reenvío al cliente.
  FWD_DOMAIN: z.string().default('fwd.sono.lat'),
  // API HTTP interna del MX propio para ENVIAR correo saliente (responder desde /admin).
  // Ej. http://86.48.30.120:8025 (auth con EMAIL_WEBHOOK_SECRET). Vacío = responder off.
  MX_SEND_API_URL: z.string().default(''),
  // API de Cloudflare (legacy, ya no se usa — migrado a ForwardEmail).
  CF_API_TOKEN: z.string().default(''),
  CF_ACCOUNT_ID: z.string().default(''),
  // API de ForwardEmail: crea un alias por cliente (recipients = correo + webhook).
  FE_API_TOKEN: z.string().default(''),

  // ---- Instagram (publicar desde el admin con la Graph API) ----
  // Page Access Token PERMANENTE (token de la página vinculada a la cuenta IG Business).
  // El IG_USER_ID es el instagram_business_account.id de la página.
  IG_ACCESS_TOKEN: z.string().default(''),
  IG_USER_ID: z.string().default(''),
  IG_GRAPH_VERSION: z.string().default('v25.0'),

  // ---- Skydropx (envíos / guías de paquetería, host api-pro) ----
  // OAuth2 client_credentials. Credenciales del panel pro.skydropx.com.
  SKYDROPX_CLIENT_ID: z.string().default(''),
  SKYDROPX_CLIENT_SECRET: z.string().default(''),
  // Punto de origen REGISTRADO en la cuenta Skydropx (address_template id, tipo "from").
  // CRÍTICO: las transportadoras con recolección agendada (Envía/Coordinadora/Servientrega)
  // SOLO cotizan si el origen es un punto válido de la cuenta. Con origen suelto (ciudad+DANE)
  // solo cotiza Interrapidísimo. Sacar el id de GET /api/v1/address_templates (el "Dispensario").
  SKYDROPX_ORIGIN_TEMPLATE_ID: z.string().default(''),
  // Origen del despacho (bodega) — fallback si NO hay template id. Colombia: postal_code = DANE 5 díg.
  SKYDROPX_ORIGIN_DANE: z.string().default('05001'),     // Medellín
  SKYDROPX_ORIGIN_DEPTO: z.string().default('Antioquia'),
  SKYDROPX_ORIGIN_CITY: z.string().default('Medellin'),
  SKYDROPX_ORIGIN_NAME: z.string().default('Sono'),      // remitente
  SKYDROPX_ORIGIN_STREET: z.string().default(''),        // dirección bodega
  SKYDROPX_ORIGIN_POSTAL: z.string().default('050001'),  // CP postal real (street meta)
  SKYDROPX_ORIGIN_PHONE: z.string().default(''),
  SKYDROPX_ORIGIN_EMAIL: z.string().default('hola@sono.lat'),
  // Token Bearer del webhook de tracking (Skydropx web → Conexiones > Webhooks). Skydropx
  // lo manda en el header Authorization de cada POST /webhook/skydropx. Vacío = no valida.
  SKYDROPX_WEBHOOK_TOKEN: z.string().default(''),

  // ---- Bot de soporte (Gemini) ----
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-flash-latest'),

  // ---- Web Push (VAPID) para notificar al dueño en el iPhone ----
  // Generar una vez con: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:hola@sono.lat'),

  LOG_LEVEL: z.enum(['trace','debug','info','warn','error']).default('info'),
});

// Tratamos env vacías ('') como ausentes para que los opcionales/defaults apliquen
// (Railway suele dejar variables seteadas pero vacías).
const raw = Object.fromEntries(
  Object.entries(process.env).filter(([k, v]) => k in ConfigSchema.shape && v !== '')
);

let parsed;
try {
  parsed = ConfigSchema.parse(raw);
} catch (e) {
  console.error('Config invalida:');
  console.error(JSON.stringify(e.errors || e, null, 2));
  process.exit(1);
}

parsed.allowedSenders = parsed.ALLOWED_SENDERS
  ? parsed.ALLOWED_SENDERS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : [];

parsed.mqttSubTopic = `speakers/${parsed.SPEAKER_DEVICE_ID}/cmd`;
parsed.mqttPubTopic = `speakers/${parsed.SPEAKER_DEVICE_ID}/status`;

// Helpers
parsed.hasOAuth = Boolean(parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET);
parsed.hasMsOAuth = Boolean(parsed.MICROSOFT_CLIENT_ID && parsed.MICROSOFT_CLIENT_SECRET);
parsed.hasMp = Boolean(parsed.MP_ACCESS_TOKEN);
parsed.hasStripe = Boolean(parsed.STRIPE_SECRET_KEY);
parsed.hasEfipay = Boolean(parsed.EFIPAY_TOKEN);
parsed.hasAdminLogin = Boolean(parsed.ADMIN_USER && parsed.ADMIN_PASS && parsed.ADMIN_TOKEN);
parsed.hasInstagram = Boolean(parsed.IG_ACCESS_TOKEN && parsed.IG_USER_ID);
parsed.hasSkydropx = Boolean(parsed.SKYDROPX_CLIENT_ID && parsed.SKYDROPX_CLIENT_SECRET);

export const config = parsed;
