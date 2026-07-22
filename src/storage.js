// Storage SQLite con encryption AES-256-GCM para refresh_tokens y passwords IMAP.
//
// Tabla `accounts` (correo que se vigila):
//   id              TEXT PK   - id interno (ej "demo" o el order id)
//   email           TEXT      - direccion de correo
//   refresh_enc     BLOB NULL - refresh_token cifrado (solo auth_type=oauth)
//   speaker_id      TEXT      - speaker MQTT (ej "spkr-001"), se asigna al despachar
//   last_history_id TEXT      - ultimo historyId procesado de Gmail API
//   watch_expires   INTEGER   - ms epoch cuando expira el watch
//   auth_type       TEXT      - 'oauth' | 'imap'
//   imap_host/port/user       - credenciales IMAP manuales (auth_type=imap)
//   imap_pass_enc   BLOB NULL - password IMAP cifrado (auth_type=imap)
//   created_at, updated_at
//
// Tabla `orders` (compra + onboarding + fulfillment):
//   id TEXT PK (token aleatorio), account_id, amount_cents, currency, status,
//   wompi_reference, wompi_txn_id (nombres heredados; hoy guardan ref/id de MercadoPago),
//   business_name, bank, address, city, phone,
//   qr_path, qr_mime, email_method, created_at, updated_at
//
// Tabla `devices` (inventario fisico de speakers):
//   spkr_id TEXT PK, mac, imei, model, status, order_id, label, created_at, updated_at

import Database from 'better-sqlite3';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

function getKey() {
  if (!config.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY no seteada');
  return Buffer.from(config.ENCRYPTION_KEY, 'base64').subarray(0, 32);
}
function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}
function decrypt(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(-16);
  const ct = buf.subarray(12, -16);
  const d = createDecipheriv('aes-256-gcm', getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

let db = null;

function ensureColumns(table, wanted) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [name, type] of wanted) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

export function openDb() {
  if (db) return db;
  mkdirSync(dirname(config.DB_PATH), { recursive: true });
  db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      refresh_enc BLOB,
      speaker_id TEXT,
      last_history_id TEXT,
      watch_expires INTEGER,
      auth_type TEXT NOT NULL DEFAULT 'oauth',
      oauth_provider TEXT NOT NULL DEFAULT 'google',
      imap_host TEXT,
      imap_port INTEGER,
      imap_user TEXT,
      imap_pass_enc BLOB,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'COP',
      status TEXT NOT NULL DEFAULT 'created',
      wompi_reference TEXT,
      wompi_txn_id TEXT,
      business_name TEXT,
      bank TEXT,
      address TEXT,
      city TEXT,
      phone TEXT,
      customer_email TEXT,
      qr_path TEXT,
      qr_mime TEXT,
      email_method TEXT,
      mp_plan_id TEXT,
      mp_customer_id TEXT,
      mp_card_id TEXT,
      mp_payer_email TEXT,
      next_charge_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(wompi_reference);

    CREATE TABLE IF NOT EXISTS devices (
      spkr_id TEXT PRIMARY KEY,
      mac TEXT UNIQUE,
      imei TEXT,
      model TEXT NOT NULL DEFAULT 'wifi',
      status TEXT NOT NULL DEFAULT 'provisionado',
      order_id TEXT,
      label TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Historial persistente de pagos detectados (lo que el speaker anunció).
    -- Antes vivía solo en memoria (announce-log); ahora sobrevive reinicios para
    -- que el admin muestre el feed por cuenta. amount en pesos, bank texto libre.
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      amount INTEGER,
      bank TEXT,
      payer TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payments_account ON payments(account_id, at DESC);

    -- Buzón: TODO correo que llega al MX a @sono.lat se guarda acá (sea de un cliente
    -- conocido o de un alias desconocido = catch-all). Reemplaza el reenvío del catch-all
    -- al correo personal: ahora se ve en /admin → Buzón. account_id NULL = desconocido.
    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias TEXT,
      account_id TEXT,
      from_addr TEXT,
      subject TEXT,
      text TEXT,
      html TEXT,
      is_payment INTEGER NOT NULL DEFAULT 0,
      seen INTEGER NOT NULL DEFAULT 0,
      message_id TEXT,         -- Message-ID del correo (para threading al responder)
      refs TEXT,               -- References del correo (threading)
      replied_at INTEGER,      -- cuándo se respondió desde /admin (NULL = sin responder)
      direction TEXT NOT NULL DEFAULT 'in',  -- 'in' recibido | 'out' enviado desde el panel
      to_addr TEXT,            -- destinatario (para los 'out')
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_at ON inbox(at DESC);

    -- Envíos creados con Skydropx para despachar el Cloud Speaker de una orden.
    -- Un envío se asocia a una orden (order_id). Guardamos lo necesario para mostrar
    -- la guía y rastrear: id de Skydropx, transportadora, nº de guía, URL del PDF y
    -- el precio cobrado. La dirección destino ya vive en orders; acá solo el resumen.
    CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      skydropx_id TEXT,
      quotation_id TEXT,
      rate_id TEXT,
      carrier TEXT,
      service TEXT,
      tracking TEXT,
      label_url TEXT,
      price_cents INTEGER,
      currency TEXT NOT NULL DEFAULT 'COP',
      to_dane TEXT,
      to_city TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id);
    CREATE INDEX IF NOT EXISTS idx_shipments_at ON shipments(created_at DESC);

    CREATE TABLE IF NOT EXISTS wa_outbox (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_outbox_order_kind ON wa_outbox(order_id, kind);
    CREATE INDEX IF NOT EXISTS idx_wa_outbox_status ON wa_outbox(status, created_at);

    CREATE TABLE IF NOT EXISTS wa_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wa_inbound (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT,
      type TEXT NOT NULL,
      body TEXT,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wa_inbound_at ON wa_inbound(received_at DESC);
  `);

  // Migraciones: agregar columnas si las tablas ya existian de una version vieja.
  // El índice de mp_plan_id va DESPUÉS de asegurar la columna (DBs viejas no la tenían).
  ensureColumns('orders', [
    ['mp_plan_id', 'TEXT'],
    ['mp_customer_id', 'TEXT'],
    ['mp_card_id', 'TEXT'],
    ['mp_payer_email', 'TEXT'],
    ['next_charge_at', 'INTEGER'],
    ['customer_email', 'TEXT'], // correo del paso 1 (sirve para prellenar el onboarding)
    // ── Plan de pago en cuotas (1ª cuota en el checkout; 2ª y 3ª por cobro programado) ──
    ['plan', 'TEXT'],                  // 'contado' | 'cuotas' (lo que eligió el cliente)
    ['card_token', 'TEXT'],           // token reutilizable de la tarjeta (EfiPay, reuse:true)
    ['installments_total', 'INTEGER'], // nº de cuotas del plan (3 en cuotas, 1/NULL en contado)
    ['installments_paid', 'INTEGER'],  // cuántas cuotas se han cobrado ya (incluye la 1ª del checkout)
    ['installment_next_at', 'INTEGER'],// epoch ms de cuándo toca cobrar la próxima cuota (NULL si no quedan)
    ['installment_fails', 'INTEGER'],  // intentos fallidos consecutivos de la cuota pendiente
    ['installments_state', 'TEXT'],   // NULL | 'al_dia' | 'en_mora' | 'completado' | 'suspendido'
    // payment_id de EfiPay del pago en curso (PSE/Bre-B/efectivo): permite consultar el
    // estado por API si el webhook no llega (red de seguridad anti-pagos-atascados).
    ['efi_payment_id', 'TEXT'],
    // Llave Bre-B del QR (multipunto): se guarda acá si el device aún no está asignado;
    // al asignar el speaker se transfiere al device.
    ['breb_key', 'TEXT'],
    ['breb_qr_json', 'TEXT'],
    ['local_name', 'TEXT'],
    // Entrega: 'online' (paga ya por la pasarela) | 'contraentrega' (paga al recibir).
    ['delivery', 'TEXT'],
    // Código DANE de la ciudad elegida en el checkout (autocomplete del catálogo
    // co-dane): destino exacto para Skydropx sin adivinar por texto.
    ['city_dane', 'TEXT'],
    // Soft-delete (archivar): la orden sale del panel pero NO se borra de la DB.
    // archived_at = epoch ms cuando se archivó (NULL = activa). prev_status = estado
    // que tenía antes de archivar, para poder restaurarla a su estado original.
    ['archived_at', 'INTEGER'],
    ['prev_status', 'TEXT'],
    // Epoch ms de cuándo se reportó el Purchase de esta orden a la Meta CAPI
    // (NULL = sin reportar). Lo marca el job de meta-capi.js; idempotencia del envío.
    ['meta_capi_at', 'INTEGER'],
  ]);
  // Cloud API oficial: wamid = id del mensaje en Meta (mapea los statuses del webhook
  // a la fila) y delivery = último estado real reportado (sent/delivered/read/failed).
  ensureColumns('wa_outbox', [
    ['wamid', 'TEXT'],
    ['delivery', 'TEXT'],
  ]);
  // CRM /soporte-app: wa_inbound pasó de "solo entrantes" a hilo de chat completo.
  // direction 'in'|'out'; delivery = status Meta de los salientes; read_at = visto
  // por el operador (contador de no-leídos por conversación).
  ensureColumns('wa_inbound', [
    ["direction", "TEXT NOT NULL DEFAULT 'in'"],
    ['delivery', 'TEXT'],
    ['read_at', 'INTEGER'],
  ]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_wa_inbound_phone ON wa_inbound(phone, received_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_wa_outbox_wamid ON wa_outbox(wamid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_plan ON orders(mp_plan_id)');
  // Índice para que el job de cobro encuentre rápido las cuotas vencidas.
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_installment_due ON orders(installment_next_at)');
  ensureColumns('accounts', [
    ['last_history_id', 'TEXT'],
    ['watch_expires', 'INTEGER'],
    ["auth_type", "TEXT NOT NULL DEFAULT 'oauth'"],
    ["oauth_provider", "TEXT NOT NULL DEFAULT 'google'"],
    ['imap_host', 'TEXT'],
    ['imap_port', 'INTEGER'],
    ['imap_user', 'TEXT'],
    ['imap_pass_enc', 'BLOB'],
    // Método "correo redirigido": el cliente redirige el correo del banco a
    // <alias>@sono.lat (Cloudflare Email Worker → webhook). forward_to = correo
    // real del cliente al que el Worker reenvía (cifrado, es dato del negocio
    // no contenido de correo). Ver memoria project_correo_redirigido.
    ['alias', 'TEXT'],
    ['forward_to_enc', 'BLOB'],
    // change_confirmed: el banco confirmó que el cambio de correo se completó
    // (cierra el onboarding automático). 0 = pendiente, timestamp = confirmado.
    ['change_confirmed', 'INTEGER'],
    // Suscripción (gestión de cliente). status: activa | suspendida.
    // El estado "vencida/en gracia" se DERIVA de next_charge_at + grace_until,
    // no se persiste. grace_until = hasta cuándo tolera el impago antes de
    // suspender solo (se setea cuando vence). suspended_at = cuándo se suspendió.
    ["sub_status", "TEXT NOT NULL DEFAULT 'activa'"],
    ['grace_until', 'INTEGER'],
    ['suspended_at', 'INTEGER'],
    // Anunciar también EGRESOS ("Transferiste $X"). Apagado por defecto;
    // será un toggle en el panel de usuario.
    ['announce_outgoing', 'INTEGER NOT NULL DEFAULT 0'],
  ]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_alias ON accounts(alias)');
  // Buzón: columnas para threading y estado de respuesta (DBs viejas no las tenían).
  ensureColumns('inbox', [
    ['message_id', 'TEXT'],
    ['refs', 'TEXT'],
    ['replied_at', 'INTEGER'],
    // direction: 'in' = recibido (catch-all), 'out' = redactado/enviado desde el panel.
    ["direction", "TEXT NOT NULL DEFAULT 'in'"],
    ['to_addr', 'TEXT'],   // a quién va (para los 'out')
  ]);

  // Envíos: agregar tracking_url después de que Skydropx retorna trackingUrl en extractLabel.
  ensureColumns('shipments', [
    ['tracking_url', 'TEXT'],
    // Estado del paquete que reporta el webhook de Skydropx (picked_up, in_transit,
    // last_mile, delivery_attempt, delivered, in_return, exception...).
    ['tracking_status', 'TEXT'],
    ['tracking_status_at', 'INTEGER'],
    ['returned', 'INTEGER'],     // 1 si el envío va en devolución al remitente
    ['returned_status', 'TEXT'], // tracking del trayecto de retorno (cuando returned=1)
  ]);

  // Telemetría del speaker (auto-provisioning): el backend escucha speakers/+/status
  // y guarda lo último que reportó el aparato. last_seen = visto online por última vez.
  ensureColumns('devices', [
    ['last_seen', 'INTEGER'],
    ['signal', 'INTEGER'],
    ['battery', 'INTEGER'],
    ['firmware', 'TEXT'],
    ['iccid', 'TEXT'],
    ['mqtt_pass', 'TEXT'],   // password MQTT del speaker (guardado al provisionar)
    ['ssid', 'TEXT'],        // WiFi al que está conectado (lo reporta el getinfo)
    // Ruteo multipunto: cada device = un local = una llave Bre-B (del QR que sube el cliente).
    ['breb_key', 'TEXT'],     // llave Bre-B normalizada del local (para rutear pagos)
    ['breb_qr_json', 'TEXT'], // JSON del QR decodificado (incl. string EMVCo crudo, para regenerar)
    ['local_name', 'TEXT'],   // nombre del comercio (tag 59 del QR)
  ]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_devices_breb_key ON devices(breb_key)');

  // Llaves Bre-B ADICIONALES de un device (multipunto/multi-llave). La principal vive
  // en devices.breb_key (viene del QR subido); estas se vinculan a mano desde el admin
  // (ej. el cliente también recibe pagos a la llave de su celular y quiere que suenen
  // en el mismo speaker). El ruteo (findDeviceByKey) matchea principal + adicionales.
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_keys (
      spkr_id TEXT NOT NULL,
      breb_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (spkr_id, breb_key)
    );
    CREATE INDEX IF NOT EXISTS idx_device_keys_key ON device_keys(breb_key);
  `);

  // Historial de pagos enriquecido para "La Libreta". unrouted=1 = pago multipunto
  // sin local (no sonó, el cliente lo ve como "local por confirmar"). msg_id =
  // Message-ID del correo para dedupe idempotente. Filas viejas quedan NULL.
  ensureColumns('payments', [
    ['breb_key', 'TEXT'],
    ['speaker_id', 'TEXT'],
    ['local_name', 'TEXT'],
    ['unrouted', 'INTEGER NOT NULL DEFAULT 0'],
    ['msg_id', 'TEXT'],
  ]);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_msgid
      ON payments(account_id, msg_id) WHERE msg_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payments_account_rowid
      ON payments(account_id, id);
  `);

  // Aplicaciones a la convocatoria UGC (creadores de Medellín). Llegan del
  // formulario público sonoback.com/convocatoria y se gestionan en /admin.
  // status: nuevo | contactado | aprobado | descartado.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ugc_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      whatsapp TEXT,
      comuna TEXT,
      redes TEXT,
      contenido TEXT,
      tipo_local TEXT,
      relacion_local TEXT,
      link_local TEXT,
      celular_graba TEXT,
      disponible_7dias TEXT,
      origen TEXT,
      ip TEXT,
      status TEXT NOT NULL DEFAULT 'nuevo',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ugc_created ON ugc_applications(created_at DESC);
  `);

  // Intents del checkout Bre-B PROPIO (sin pasarela): el cliente ve el QR estático
  // de la cuenta Nequi de Sonó + un monto exacto + ventana de 2 min. Cuando el correo
  // de Nequi llega a la cuenta de pagos de Sonó con ese monto, el intent pendiente
  // más viejo con ese monto (FIFO) se marca 'paid' y su orden queda pagada.
  // amount en PESOS (igual que payments.amount, lo que parsea el correo del banco).
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      bank TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      paid_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_intents_match ON payment_intents(status, amount, created_at);
    CREATE INDEX IF NOT EXISTS idx_intents_order ON payment_intents(order_id, created_at DESC);
  `);

  // OTP de confirmación del banco (cambio de correo). Persistido CIFRADO con TTL de
  // 10 min para sobrevivir reinicios de pm2 (antes vivía solo en RAM y cada deploy lo
  // borraba: el cliente nunca veía su código). code_enc = AES-256-GCM, igual que los
  // refresh tokens. Se borra al confirmar o al expirar; nunca queda más de 10 min.
  db.exec(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      account_id TEXT PRIMARY KEY,
      code_enc BLOB NOT NULL,
      at INTEGER NOT NULL
    );
  `);

  return db;
}

// ---------------------------------------------------------------------------
// OTP de confirmación (efímero, cifrado). Lo usa otp-capture.js.
// ---------------------------------------------------------------------------

export function saveOtpCode(accountId, code) {
  db.prepare('INSERT INTO otp_codes (account_id, code_enc, at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET code_enc = excluded.code_enc, at = excluded.at')
    .run(accountId, encrypt(code), Date.now());
}

export function loadOtpCode(accountId) {
  const r = db.prepare('SELECT code_enc, at FROM otp_codes WHERE account_id = ?').get(accountId);
  if (!r) return null;
  try {
    return { code: decrypt(r.code_enc), at: r.at };
  } catch {
    return null;
  }
}

export function deleteOtpCode(accountId) {
  db.prepare('DELETE FROM otp_codes WHERE account_id = ?').run(accountId);
}

/** Barre los OTP vencidos (los llama otp-capture con el TTL). */
export function purgeOtpCodes(olderThanMs) {
  db.prepare('DELETE FROM otp_codes WHERE at < ?').run(Date.now() - olderThanMs);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function hydrateAccount(r) {
  if (!r) return null;
  const out = { ...r };
  if (r.refresh_enc) out.refreshToken = decrypt(r.refresh_enc);
  if (r.imap_pass_enc) out.imapPass = decrypt(r.imap_pass_enc);
  if (r.forward_to_enc) out.forwardTo = decrypt(r.forward_to_enc);
  return out;
}

/**
 * Crea o actualiza una cuenta de correo a vigilar.
 * Para Gmail OAuth: pasar { authType:'oauth', refreshToken }.
 * Para IMAP manual: pasar { authType:'imap', imapHost, imapPort, imapUser, imapPass }.
 * Campos no provistos no se sobreescriben en updates (COALESCE).
 */
export function upsertAccount({
  id, email, refreshToken, speakerId,
  authType = 'oauth', provider = 'google', imapHost, imapPort, imapUser, imapPass,
}) {
  openDb();
  const now = Date.now();
  const refreshEnc = refreshToken ? encrypt(refreshToken) : null;
  const imapPassEnc = imapPass ? encrypt(imapPass) : null;

  db.prepare(`
    INSERT INTO accounts (
      id, email, refresh_enc, speaker_id, auth_type, oauth_provider,
      imap_host, imap_port, imap_user, imap_pass_enc, created_at, updated_at
    )
    VALUES (@id, @email, @refreshEnc, @speakerId, @authType, @provider,
            @imapHost, @imapPort, @imapUser, @imapPassEnc, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      email         = excluded.email,
      refresh_enc   = COALESCE(excluded.refresh_enc, accounts.refresh_enc),
      speaker_id    = COALESCE(excluded.speaker_id, accounts.speaker_id),
      auth_type     = excluded.auth_type,
      oauth_provider= excluded.oauth_provider,
      imap_host     = COALESCE(excluded.imap_host, accounts.imap_host),
      imap_port     = COALESCE(excluded.imap_port, accounts.imap_port),
      imap_user     = COALESCE(excluded.imap_user, accounts.imap_user),
      imap_pass_enc = COALESCE(excluded.imap_pass_enc, accounts.imap_pass_enc),
      updated_at    = excluded.updated_at
  `).run({
    id, email, refreshEnc, speakerId: speakerId || null, authType, provider,
    imapHost: imapHost || null, imapPort: imapPort || null,
    imapUser: imapUser || null, imapPassEnc, now,
  });
}

/** Actualiza el refresh_token cifrado (Microsoft rota el refresh token en cada renovación). */
export function updateAccountRefresh(id, refreshToken) {
  openDb();
  db.prepare('UPDATE accounts SET refresh_enc = ?, updated_at = ? WHERE id = ?')
    .run(encrypt(refreshToken), Date.now(), id);
}

export function getAccount(id) {
  openDb();
  return hydrateAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
}

export function getAccountByEmail(email) {
  openDb();
  return hydrateAccount(db.prepare('SELECT * FROM accounts WHERE email = ?').get(email));
}

/** Busca la cuenta por su alias de correo redirigido (ej. 'juan-abc' de juan-abc@sono.lat). */
export function getAccountByAlias(alias) {
  openDb();
  return hydrateAccount(db.prepare('SELECT * FROM accounts WHERE alias = ?').get(alias));
}

/** Renombra el alias del correo redirigido de una cuenta (desde el admin).
 *  Solo cambia alias + email visibles; el forward_to cifrado y los pagos quedan intactos.
 *  El alias viejo deja de resolver → esos correos caen al buzón catch-all (no se pierden). */
export function renameAccountAlias(id, alias, email) {
  openDb();
  return db.prepare('UPDATE accounts SET alias = ?, email = ?, updated_at = ? WHERE id = ?')
    .run(alias, email, Date.now(), id).changes > 0;
}

/** Asigna alias + correo de reenvío (cifrado) a una cuenta del método correo-redirigido. */
export function setAccountForward(id, { alias, forwardTo }) {
  openDb();
  db.prepare('UPDATE accounts SET alias = ?, forward_to_enc = ?, updated_at = ? WHERE id = ?')
    .run(alias, forwardTo ? encrypt(forwardTo) : null, Date.now(), id);
}

/**
 * Busca una cuenta EXISTENTE cuyo correo de reenvío (forward_to, cifrado) coincida con
 * `forwardTo`. Sirve para detectar, en el onboarding, que el cliente ya tiene una cuenta
 * con ese correo (multipunto: ofrecerle asociar el nuevo local a la misma cuenta).
 * Excluye la cuenta `exceptId` (la de la orden actual). Devuelve la cuenta hidratada o null.
 */
export function findAccountByForward(forwardTo, exceptId = null) {
  openDb();
  if (!forwardTo) return null;
  const target = String(forwardTo).trim().toLowerCase();
  const rows = db.prepare('SELECT * FROM accounts WHERE forward_to_enc IS NOT NULL').all();
  for (const r of rows) {
    if (r.id === exceptId) continue;
    let dec = null;
    try { dec = decrypt(r.forward_to_enc); } catch { continue; }
    if (dec && dec.trim().toLowerCase() === target) return hydrateAccount(r);
  }
  return null;
}

/** Marca que el banco confirmó el cambio de correo (cierra el onboarding automático). */
export function markChangeConfirmed(id) {
  openDb();
  db.prepare('UPDATE accounts SET change_confirmed = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), id);
}

/** Reabre el paso "conectar el correo": limpia la confirmación del cambio de correo.
 *  (Reset desde el admin; la cuenta, el alias y los pagos históricos NO se tocan.) */
export function resetChangeConfirmed(id) {
  openDb();
  db.prepare('UPDATE accounts SET change_confirmed = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
}

export function setAccountSpeaker(id, speakerId) {
  openDb();
  return db.prepare('UPDATE accounts SET speaker_id = ?, updated_at = ? WHERE id = ?')
    .run(speakerId, Date.now(), id).changes > 0;
}

export function updateAccountHistory(id, historyId) {
  openDb();
  db.prepare('UPDATE accounts SET last_history_id = ?, updated_at = ? WHERE id = ?')
    .run(String(historyId), Date.now(), id);
}

export function updateAccountWatch(id, expirationMs) {
  openDb();
  db.prepare('UPDATE accounts SET watch_expires = ?, updated_at = ? WHERE id = ?')
    .run(expirationMs, Date.now(), id);
}

export function listAccounts() {
  openDb();
  return db.prepare(`SELECT id, email, speaker_id, last_history_id, watch_expires,
    auth_type, created_at, updated_at FROM accounts`).all();
}

export function deleteAccount(id) {
  openDb();
  return db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Suscripción / gestión de cliente (account = cliente)
// ---------------------------------------------------------------------------

const GRACE_DAYS = 3;           // días de gracia tras vencer antes de suspender solo
const DAY_MS = 24 * 3600 * 1000;

/** Estado DERIVADO de la suscripción de una cuenta, combinando el flag persistido
 *  (sub_status) con el vencimiento de su orden (next_charge_at) y la gracia.
 *  Devuelve: 'activa' | 'por_vencer' | 'vencida' | 'suspendida'. */
export function subState(acc, nextChargeAt) {
  if (!acc) return 'activa';
  if (acc.sub_status === 'suspendida') return 'suspendida';
  if (!nextChargeAt) return 'activa';
  const now = Date.now();
  if (nextChargeAt > now) {
    const daysLeft = Math.ceil((nextChargeAt - now) / DAY_MS);
    return daysLeft <= 7 ? 'por_vencer' : 'activa';
  }
  // ya venció: en gracia hasta grace_until (o nextCharge + GRACE_DAYS)
  const graceEnd = acc.grace_until || (nextChargeAt + GRACE_DAYS * DAY_MS);
  return now <= graceEnd ? 'vencida' : 'suspendida';
}

/** Prende/apaga el anuncio de egresos ("Transferiste $X") para una cuenta. */
export function setAnnounceOutgoing(id, on) {
  openDb();
  db.prepare('UPDATE accounts SET announce_outgoing = ?, updated_at = ? WHERE id = ?')
    .run(on ? 1 : 0, Date.now(), id);
}

/** Cambia el estado de suscripción de una cuenta (suspender / reactivar manual). */
export function setSubStatus(id, status, extra = {}) {
  openDb();
  const now = Date.now();
  const fields = ['sub_status = @status', 'updated_at = @now'];
  const params = { id, status, now };
  if ('grace_until' in extra) { fields.push('grace_until = @grace_until'); params.grace_until = extra.grace_until; }
  if (status === 'suspendida') { fields.push('suspended_at = @now'); }
  if (status === 'activa') { fields.push('suspended_at = NULL', 'grace_until = NULL'); }
  db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getAccount(id);
}

/** Cuentas que el job debería suspender solas: vencidas, fuera de gracia, aún activas. */
export function accountsToAutoSuspend() {
  openDb();
  const now = Date.now();
  // unir cuentas con su orden (la que tiene next_charge_at) y filtrar
  const rows = db.prepare(`
    SELECT a.id AS account_id, a.sub_status, a.grace_until, o.next_charge_at
    FROM accounts a
    JOIN orders o ON o.account_id = a.id
    WHERE a.sub_status = 'activa' AND o.next_charge_at IS NOT NULL AND o.next_charge_at < ?
  `).all(now);
  return rows.filter(r => {
    const graceEnd = r.grace_until || (r.next_charge_at + GRACE_DAYS * DAY_MS);
    return now > graceEnd;
  });
}

/** Setea grace_until para cuentas recién vencidas que aún no lo tienen. */
export function markNewlyExpired() {
  openDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT a.id, o.next_charge_at FROM accounts a
    JOIN orders o ON o.account_id = a.id
    WHERE a.sub_status = 'activa' AND a.grace_until IS NULL
      AND o.next_charge_at IS NOT NULL AND o.next_charge_at < ?
  `).all(now);
  for (const r of rows) {
    db.prepare('UPDATE accounts SET grace_until = ?, updated_at = ? WHERE id = ?')
      .run(r.next_charge_at + GRACE_DAYS * DAY_MS, now, r.id);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** Crea una orden nueva (estado 'created') y devuelve su id (token aleatorio). */
export function createOrder({ amountCents, currency = 'COP', wompiReference }) {
  openDb();
  const now = Date.now();
  const id = randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO orders (id, amount_cents, currency, status, wompi_reference, created_at, updated_at)
    VALUES (@id, @amountCents, @currency, 'created', @wompiReference, @now, @now)
  `).run({ id, amountCents, currency, wompiReference: wompiReference || id, now });
  return id;
}

export function getOrder(id) {
  openDb();
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
}

export function getOrderByReference(ref) {
  openDb();
  return db.prepare('SELECT * FROM orders WHERE wompi_reference = ?').get(ref) || null;
}

export function getOrderByPlanId(planId) {
  openDb();
  if (!planId) return null;
  return db.prepare('SELECT * FROM orders WHERE mp_plan_id = ?').get(planId) || null;
}

/** Actualiza campos de una orden. `patch` es un objeto { campo: valor }. */
export function updateOrder(id, patch) {
  openDb();
  const allowed = new Set([
    'account_id', 'status', 'wompi_reference', 'wompi_txn_id',
    'business_name', 'bank', 'address', 'city', 'city_dane', 'phone', 'customer_email',
    'qr_path', 'qr_mime', 'email_method', 'mp_plan_id',
    'mp_customer_id', 'mp_card_id', 'mp_payer_email', 'next_charge_at',
    // plan de cuotas
    'plan', 'card_token', 'installments_total', 'installments_paid',
    'installment_next_at', 'installment_fails', 'installments_state',
    'efi_payment_id',
    // llave Bre-B del QR (multipunto)
    'breb_key', 'breb_qr_json', 'local_name',
    // entrega: 'online' (default) | 'contraentrega' (paga al recibir)
    'delivery',
    // soft-delete (archivar)
    'archived_at', 'prev_status',
  ]);
  const keys = Object.keys(patch).filter(k => allowed.has(k));
  if (keys.length === 0) return false;
  const setSql = keys.map(k => `${k} = @${k}`).join(', ');
  const params = { id, updated_at: Date.now() };
  for (const k of keys) params[k] = patch[k];
  return db.prepare(`UPDATE orders SET ${setSql}, updated_at = @updated_at WHERE id = @id`)
    .run(params).changes > 0;
}

// Marca la orden como reportada a la Meta CAPI. Statement dedicado (no updateOrder):
// no debe pisar updated_at, que en otras partes se lee como "último avance del cliente".
export function markOrderMetaCapi(id) {
  openDb();
  return db.prepare('UPDATE orders SET meta_capi_at = ? WHERE id = ?')
    .run(Date.now(), id).changes > 0;
}

export function listOrders() {
  openDb();
  return db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
}

// ---------------------------------------------------------------------------
// Devices (inventario)
// ---------------------------------------------------------------------------

/** Registra una unidad fisica al provisionar. status default 'provisionado'. */
export function createDevice({ spkrId, mac, imei, model = 'wifi', label, status = 'provisionado', mqttPass }) {
  openDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO devices (spkr_id, mac, imei, model, status, label, mqtt_pass, created_at, updated_at)
    VALUES (@spkrId, @mac, @imei, @model, @status, @label, @mqttPass, @now, @now)
    ON CONFLICT(spkr_id) DO UPDATE SET
      mac = excluded.mac, imei = excluded.imei, model = excluded.model,
      label = excluded.label,
      mqtt_pass = COALESCE(excluded.mqtt_pass, devices.mqtt_pass),
      updated_at = excluded.updated_at
  `).run({ spkrId, mac: mac || null, imei: imei || null, model, status, label: label || null, mqttPass: mqttPass || null, now });
  return getDevice(spkrId);
}

export function getDevice(spkrId) {
  openDb();
  return db.prepare('SELECT * FROM devices WHERE spkr_id = ?').get(spkrId) || null;
}

export function listDevices() {
  openDb();
  return db.prepare('SELECT * FROM devices ORDER BY spkr_id').all();
}

/** Vincula un device a una orden: marca asignado + order_id. No toca accounts. */
export function assignDevice(spkrId, orderId) {
  openDb();
  return db.prepare(`UPDATE devices SET status = 'asignado', order_id = ?, updated_at = ?
    WHERE spkr_id = ?`).run(orderId, Date.now(), spkrId).changes > 0;
}

/**
 * Guarda la llave Bre-B (y datos del QR) de un device. Usado al subir el QR del local.
 * `key` debe venir ya normalizada (minúsculas, trim). `qrJson` es el objeto decodificado.
 */
/** Renombra el LOCAL de un device (nombre del comercio que ve el cliente en los
 *  chips de La Libreta) y PROPAGA el nombre a las ventas ya guardadas de esa llave
 *  (cada fila de payments lleva su copia de local_name). Devuelve cuántos pagos
 *  se actualizaron, o null si el device no existe. */
export function renameDeviceLocal(spkrId, name) {
  openDb();
  const dev = db.prepare(
    `SELECT d.spkr_id, d.breb_key, o.account_id
     FROM devices d LEFT JOIN orders o ON o.id = d.order_id
     WHERE d.spkr_id = ?`
  ).get(spkrId);
  if (!dev) return null;
  db.prepare('UPDATE devices SET local_name = ?, updated_at = ? WHERE spkr_id = ?')
    .run(name, Date.now(), spkrId);
  let pagos = 0;
  if (dev.account_id) {
    if (dev.breb_key) {
      pagos += db.prepare(
        'UPDATE payments SET local_name = ? WHERE account_id = ? AND breb_key = ?'
      ).run(name, dev.account_id, dev.breb_key).changes;
    }
    // Pagos atribuidos a este speaker sin llave (mono-local o Gmail): también.
    pagos += db.prepare(
      `UPDATE payments SET local_name = ? WHERE account_id = ? AND speaker_id = ?
       AND (breb_key IS NULL OR breb_key = '')`
    ).run(name, dev.account_id, spkrId).changes;
  }
  return { ok: true, pagos };
}

export function setDeviceBrebKey(spkrId, { key, qrJson = null, localName = null }) {
  openDb();
  return db.prepare(`UPDATE devices SET breb_key = ?, breb_qr_json = ?, local_name = ?, updated_at = ?
    WHERE spkr_id = ?`)
    .run(key || null, qrJson ? JSON.stringify(qrJson) : null, localName || null, Date.now(), spkrId)
    .changes > 0;
}

/**
 * Lista los devices de una cuenta (vía la orden vinculada). Una cuenta puede tener
 * varios devices = varios locales. Devuelve filas de devices con su order_id/account.
 */
export function listDevicesByAccount(accountId) {
  openDb();
  if (!accountId) return [];
  return db.prepare(`
    SELECT d.* FROM devices d
    JOIN orders o ON o.id = d.order_id
    WHERE o.account_id = ?
    ORDER BY d.spkr_id
  `).all(accountId);
}

/**
 * Busca el device de una cuenta cuya llave Bre-B coincide (para rutear un pago).
 * `key` debe venir normalizada. Devuelve el device o null.
 */
export function findDeviceByKey(accountId, key) {
  openDb();
  if (!accountId || !key) return null;
  // Matchea la llave principal (devices.breb_key) O una adicional (device_keys).
  return db.prepare(`
    SELECT d.* FROM devices d
    JOIN orders o ON o.id = d.order_id
    WHERE o.account_id = ?
      AND (d.breb_key = ? OR EXISTS (
        SELECT 1 FROM device_keys k WHERE k.spkr_id = d.spkr_id AND k.breb_key = ?
      ))
    LIMIT 1
  `).get(accountId, key, key) || null;
}

/** Llaves Bre-B adicionales de un device (las manuales del admin, sin la principal). */
export function listDeviceKeys(spkrId) {
  openDb();
  return db.prepare(
    'SELECT breb_key FROM device_keys WHERE spkr_id = ? ORDER BY created_at'
  ).all(spkrId).map((r) => r.breb_key);
}

/** Vincula una llave adicional a un device. Idempotente. `key` ya normalizada. */
export function addDeviceKey(spkrId, key) {
  openDb();
  return db.prepare(
    'INSERT OR IGNORE INTO device_keys (spkr_id, breb_key, created_at) VALUES (?, ?, ?)'
  ).run(spkrId, key, Date.now()).changes > 0;
}

/** Quita una llave adicional de un device. */
export function removeDeviceKey(spkrId, key) {
  openDb();
  return db.prepare(
    'DELETE FROM device_keys WHERE spkr_id = ? AND breb_key = ?'
  ).run(spkrId, key).changes > 0;
}

/** Desasigna un device: limpia order_id y vuelve a 'provisionado'. Las llaves
 *  adicionales se borran (son del cliente, no del aparato: no deben viajar si
 *  el speaker se reasigna a otra cuenta). */
export function unassignDevice(spkrId) {
  openDb();
  db.prepare('DELETE FROM device_keys WHERE spkr_id = ?').run(spkrId);
  return db.prepare(`UPDATE devices SET status = 'provisionado', order_id = NULL, updated_at = ?
    WHERE spkr_id = ?`).run(Date.now(), spkrId).changes > 0;
}

export function setDeviceStatus(spkrId, status) {
  openDb();
  return db.prepare('UPDATE devices SET status = ?, updated_at = ? WHERE spkr_id = ?')
    .run(status, Date.now(), spkrId).changes > 0;
}

/**
 * Auto-provisioning: el speaker reportó por speakers/<spkrId>/status. Si no existe,
 * lo crea como 'provisionado'; si existe, actualiza su telemetría. Nunca pisa el
 * order_id ni baja el estado de un device ya 'asignado'/'enviado'.
 * @param {string} spkrId  - ClientID del topic (speakers/<spkrId>/status)
 * @param {Object} info    - { mac, imei, iccid, model, signal, battery, firmware }
 */
export function upsertDeviceFromStatus(spkrId, info = {}) {
  openDb();
  if (!spkrId) return null;
  const now = Date.now();
  const existing = getDevice(spkrId);
  // La columna mac es UNIQUE. Si esta MAC ya pertenece a OTRO spkr_id (mismo hardware
  // provisionado con dos ClientIDs), NO la escribimos para no romper el constraint.
  let mac = info.mac || null;
  if (mac) {
    const owner = db.prepare('SELECT spkr_id FROM devices WHERE mac = ?').get(mac);
    if (owner && owner.spkr_id !== spkrId) mac = null; // MAC tomada por otro device
  }
  if (!existing) {
    db.prepare(`
      INSERT INTO devices (spkr_id, mac, imei, iccid, model, status, signal, battery, firmware, ssid, last_seen, created_at, updated_at)
      VALUES (@spkrId, @mac, @imei, @iccid, @model, 'provisionado', @signal, @battery, @firmware, @ssid, @now, @now, @now)
    `).run({
      spkrId,
      mac, imei: info.imei || null, iccid: info.iccid || null,
      model: info.model || (info.imei ? '4g' : 'wifi'),
      signal: info.signal ?? null, battery: info.battery ?? null, firmware: info.firmware || null,
      ssid: info.ssid || null,
      now,
    });
    return { created: true, device: getDevice(spkrId) };
  }
  // Update telemetría (sólo campos presentes). No tocar status/order_id.
  db.prepare(`
    UPDATE devices SET
      mac = COALESCE(@mac, mac), imei = COALESCE(@imei, imei), iccid = COALESCE(@iccid, iccid),
      signal = COALESCE(@signal, signal), battery = COALESCE(@battery, battery),
      firmware = COALESCE(@firmware, firmware), ssid = COALESCE(@ssid, ssid),
      last_seen = @now, updated_at = @now
    WHERE spkr_id = @spkrId
  `).run({
    spkrId,
    mac, imei: info.imei || null, iccid: info.iccid || null,
    signal: info.signal ?? null, battery: info.battery ?? null, firmware: info.firmware || null,
    ssid: info.ssid || null,
    now,
  });
  return { created: false, device: getDevice(spkrId) };
}

// ---------------------------------------------------------------------------
// Payments (historial de pagos detectados, por cuenta)
// ---------------------------------------------------------------------------

/** Guarda un pago. `at` DEBE venir de announcePayment (mismo timestamp que
 *  announce-log). Si msgId ya existe para la cuenta → no inserta (dedupe). */
export function recordPayment({ accountId, amount, bank, payer, brebKey = null,
  speakerId = null, localName = null, unrouted = false, msgId = null, at = Date.now() }) {
  openDb();
  if (!accountId) return null;
  const info = db.prepare(
    `INSERT OR IGNORE INTO payments
       (account_id, amount, bank, payer, breb_key, speaker_id, local_name, unrouted, msg_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(accountId, amount ?? null, bank || null, payer || null, brebKey || null,
        speakerId || null, localName || null, unrouted ? 1 : 0, msgId || null, at);
  if (info.changes === 0) return null; // duplicado por msg_id
  return { id: info.lastInsertRowid, accountId, amount, bank, payer, brebKey, speakerId, localName, unrouted, at };
}

/** Speakers de los clientes que reciben pagos de un banco (para el aviso de demora
 *  segmentado). Une el speaker del pago (multipunto) con el de la cuenta, sobre los
 *  pagos desde `sinceMs`. Excluye cuentas suspendidas (sus speakers no deben sonar). */
export function speakersForBank(bank, sinceMs) {
  openDb();
  if (!bank) return [];
  return db
    .prepare(
      `SELECT DISTINCT s FROM (
         SELECT p.speaker_id AS s FROM payments p
           JOIN accounts a ON a.id = p.account_id
          WHERE p.bank = ? AND p.at >= ? AND p.speaker_id IS NOT NULL
            AND COALESCE(a.sub_status, '') != 'suspendida'
         UNION
         SELECT a.speaker_id AS s FROM payments p
           JOIN accounts a ON a.id = p.account_id
          WHERE p.bank = ? AND p.at >= ? AND a.speaker_id IS NOT NULL
            AND COALESCE(a.sub_status, '') != 'suspendida'
       ) WHERE s IS NOT NULL AND s != ''`
    )
    .all(bank, sinceMs, bank, sinceMs)
    .map((r) => r.s);
}

/** Últimos pagos de una cuenta (más recientes primero). */
export function paymentsFor(accountId, limit = 50) {
  openDb();
  if (!accountId) return [];
  return db.prepare(
    'SELECT id, amount, bank, payer, breb_key, speaker_id, local_name, unrouted, at FROM payments WHERE account_id = ? ORDER BY at DESC LIMIT ?'
  ).all(accountId, limit);
}

/** Agregado de ventas en [fromMs, toMs). Incluye unrouted; excluye montos nulos/<=0. */
export function paymentsAggregate(accountId, fromMs, toMs) {
  openDb();
  return db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
     FROM payments WHERE account_id = ? AND at >= ? AND at < ? AND amount > 0`
  ).get(accountId, fromMs, toMs);
}

/** Histograma por hora Bogotá (0-23) desde fromMs. 18000000 = 5h en ms. */
export function bestHours(accountId, fromMs, limit = 24) {
  openDb();
  return db.prepare(
    `SELECT CAST(((at - 18000000) / 3600000) % 24 AS INTEGER) AS hour,
            COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
     FROM payments WHERE account_id = ? AND at >= ? AND amount > 0
     GROUP BY hour ORDER BY n DESC, total DESC LIMIT ?`
  ).all(accountId, fromMs, limit);
}

/** Polling en vivo: filas con id > afterId, más nuevas primero. Pedir limit+1 para detectar gap. */
export function paymentsAfter(accountId, afterId, limit = 51) {
  openDb();
  return db.prepare(
    `SELECT id, amount, bank, local_name, breb_key, unrouted, at
     FROM payments WHERE account_id = ? AND id > ? AND amount > 0
     ORDER BY id DESC LIMIT ?`
  ).all(accountId, afterId, limit);
}

/** Filtro por fecha de La Libreta: filas de [fromMs, toMs) con id < beforeId,
 *  más nuevas primero. beforeId=MAX_SAFE_INTEGER → primera página del día. */
export function paymentsPageRange(accountId, fromMs, toMs, beforeId, limit = 50) {
  openDb();
  return db.prepare(
    `SELECT id, amount, bank, local_name, breb_key, unrouted, at
     FROM payments WHERE account_id = ? AND at >= ? AND at < ? AND id < ? AND amount > 0
     ORDER BY id DESC LIMIT ?`
  ).all(accountId, fromMs, toMs, beforeId, limit);
}

/** Paginación histórico: filas con id < beforeId (beforeId=Infinity → primera página). */
export function paymentsPage(accountId, beforeId, limit = 30) {
  openDb();
  return db.prepare(
    `SELECT id, amount, bank, local_name, breb_key, unrouted, at
     FROM payments WHERE account_id = ? AND id < ? AND amount > 0
     ORDER BY id DESC LIMIT ?`
  ).all(accountId, beforeId, limit);
}

// ── Buzón (catch-all) ─────────────────────────────────────────────────────────
// Todo correo que llega al MX se guarda acá para verlo en /admin → Buzón.

/** Guarda un correo entrante. accountId NULL = alias desconocido (catch-all). */
export function saveInboxMail({ alias, accountId = null, from = '', subject = '', text = '', html = '', isPayment = false, messageId = null, references = null }) {
  openDb();
  const at = Date.now();
  // Recortamos para no inflar la DB. Los pagos llegan a cada rato y su HTML de banco
  // es puro adorno → cortos. El resto (soporte/catch-all) es raro pero puede traer
  // comprobantes embebidos como data: URIs base64, y un corte los deja ilegibles
  // (pasó el 3-jul-2026 con un comprobante real) → margen amplio.
  const t = String(text || '').slice(0, isPayment ? 20000 : 100000);
  const h = String(html || '').slice(0, isPayment ? 60000 : 8_000_000);
  const info = db.prepare(
    `INSERT INTO inbox (alias, account_id, from_addr, subject, text, html, is_payment, message_id, refs, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(alias || null, accountId, from || null, subject || null, t, h, isPayment ? 1 : 0, messageId || null, references || null, at);
  return { id: info.lastInsertRowid, at };
}

/** Marca un correo del buzón como respondido. */
export function markInboxReplied(id) {
  openDb();
  return db.prepare('UPDATE inbox SET replied_at = ?, seen = 1 WHERE id = ?').run(Date.now(), id).changes > 0;
}

/** Guarda un correo SALIENTE redactado desde el panel (historial de enviados). */
export function saveOutboundMail({ alias, to, subject = '', text = '', messageId = null }) {
  openDb();
  const at = Date.now();
  const info = db.prepare(
    `INSERT INTO inbox (alias, direction, to_addr, from_addr, subject, text, html, is_payment, seen, message_id, at)
     VALUES (?, 'out', ?, ?, ?, ?, '', 0, 1, ?, ?)`
  ).run(alias || null, to || null, `${alias}@sono.lat`, subject || null, String(text || '').slice(0, 20000), messageId || null, at);
  return { id: info.lastInsertRowid, at };
}

/** Lista correos del buzón (más recientes primero). Por defecto sin el cuerpo (liviano). */
export function listInbox({ limit = 100, includeBody = false } = {}) {
  openDb();
  const cols = includeBody
    ? 'id, alias, account_id, direction, to_addr, from_addr, subject, text, html, is_payment, seen, replied_at, message_id, refs, at'
    : 'id, alias, account_id, direction, to_addr, from_addr, subject, is_payment, seen, replied_at, at, length(text) AS text_len';
  return db.prepare(`SELECT ${cols} FROM inbox ORDER BY at DESC LIMIT ?`).all(limit);
}

/** Un correo completo del buzón (con cuerpo). */
export function getInboxMail(id) {
  openDb();
  return db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) || null;
}

/** Marca un correo como leído. */
export function markInboxSeen(id) {
  openDb();
  return db.prepare('UPDATE inbox SET seen = 1 WHERE id = ?').run(id).changes > 0;
}

/** Borra un correo del buzón. */
export function deleteInboxMail(id) {
  openDb();
  return db.prepare('DELETE FROM inbox WHERE id = ?').run(id).changes > 0;
}

/** Cuántos correos sin leer (para el badge del tab). */
export function unseenInboxCount() {
  openDb();
  return db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE seen = 0').get().n;
}

// ---------------------------------------------------------------------------
// Shipments (envíos Skydropx para despachar el speaker de una orden)
// ---------------------------------------------------------------------------

/** Crea la fila de un envío recién generado. Devuelve la fila completa. */
export function createShipmentRow({
  orderId, skydropxId = null, quotationId = null, rateId = null,
  carrier = null, service = null, tracking = null, labelUrl = null, trackingUrl = null,
  priceCents = null, currency = 'COP', toDane = null, toCity = null, status = 'created',
}) {
  openDb();
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO shipments
      (order_id, skydropx_id, quotation_id, rate_id, carrier, service, tracking,
       label_url, tracking_url, price_cents, currency, to_dane, to_city, status, created_at, updated_at)
    VALUES
      (@orderId, @skydropxId, @quotationId, @rateId, @carrier, @service, @tracking,
       @labelUrl, @trackingUrl, @priceCents, @currency, @toDane, @toCity, @status, @now, @now)
  `).run({
    orderId, skydropxId, quotationId, rateId, carrier, service, tracking,
    labelUrl, trackingUrl, priceCents, currency, toDane, toCity, status, now,
  });
  return getShipmentRow(info.lastInsertRowid);
}

/** Una fila de envío por su id interno. */
export function getShipmentRow(id) {
  openDb();
  return db.prepare('SELECT * FROM shipments WHERE id = ?').get(id) || null;
}

/** Último envío de una orden (más reciente), o null si no tiene. */
export function getShipmentByOrder(orderId) {
  openDb();
  return db.prepare(
    'SELECT * FROM shipments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(orderId) || null;
}

/** Busca el envío al que corresponde un evento del webhook de tracking de Skydropx:
 *  primero por el UUID del shipment (relationships.shipment.data.id), luego por guía. */
export function getShipmentByTrackingOrId({ skydropxId, tracking }) {
  openDb();
  if (skydropxId) {
    const row = db.prepare('SELECT * FROM shipments WHERE skydropx_id = ?').get(skydropxId);
    if (row) return row;
  }
  if (tracking) {
    const row = db.prepare('SELECT * FROM shipments WHERE tracking = ?').get(tracking);
    if (row) return row;
  }
  return null;
}

/** Actualiza campos de un envío. `patch` es { campo: valor } (whitelist). */
export function updateShipmentRow(id, patch) {
  openDb();
  const allowed = new Set([
    'skydropx_id', 'quotation_id', 'rate_id', 'carrier', 'service', 'tracking',
    'label_url', 'price_cents', 'currency', 'to_dane', 'to_city', 'status', 'tracking_url',
    'tracking_status', 'tracking_status_at', 'returned', 'returned_status',
  ]);
  const keys = Object.keys(patch).filter((k) => allowed.has(k));
  if (keys.length === 0) return false;
  const setSql = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = { id, updated_at: Date.now() };
  for (const k of keys) params[k] = patch[k];
  return db.prepare(`UPDATE shipments SET ${setSql}, updated_at = @updated_at WHERE id = @id`)
    .run(params).changes > 0;
}

/** Todos los envíos (más recientes primero), para el tab Envíos del admin. */
export function listShipments() {
  openDb();
  return db.prepare('SELECT * FROM shipments ORDER BY created_at DESC').all();
}

/** Borra la fila de un envío (tras cancelar en Skydropx o si quedó huérfana). */
export function deleteShipment(id) {
  openDb();
  return db.prepare('DELETE FROM shipments WHERE id = ?').run(id).changes > 0;
}

/** Envíos sin tracking aún (label asíncrono de Skydropx), creados desde `sinceMs`.
 *  Usado por el job que completa el WhatsApp de guía cuando el tracking llega tarde. */
export function shipmentsAwaitingTracking(sinceMs) {
  openDb();
  return db.prepare(
    `SELECT * FROM shipments WHERE (tracking IS NULL OR tracking = '') AND created_at >= ? ORDER BY created_at ASC`
  ).all(sinceMs);
}

// ── Cola de WhatsApp saliente (wa_outbox) ────────────────────────────────────
// El VM encola; el agente de la PC del dueño consume por polling. Idempotente por
// (order_id, kind): encolar dos veces el mismo mensaje para la misma orden no duplica.

export function enqueueWa({ orderId, phone, kind, body }) {
  openDb();
  const now = Date.now();
  const id = randomBytes(16).toString('hex');
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO wa_outbox (id, order_id, phone, kind, body, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, ?)`
    )
    .run(id, orderId, phone, kind, body, now);
  return info.changes > 0; // 0 = ya existía ese (order_id, kind)
}

/** ¿Ya hay un WhatsApp del mismo tipo al MISMO teléfono (de OTRA orden) reciente?
 *  Un cliente con varias órdenes (ej: reintentó el checkout y quedó duplicada) recibía
 *  el mismo recordatorio una vez por orden. Solo bloquean queued/sending/sent:
 *  failed/canceled no cuentan (se puede reintentar). */
export function hasRecentWa({ phone, kind, excludeOrderId, sinceMs }) {
  openDb();
  const row = db
    .prepare(
      `SELECT 1 FROM wa_outbox
       WHERE phone = ? AND kind = ? AND order_id != ?
         AND status IN ('queued', 'sending', 'sent')
         AND created_at >= ?
       LIMIT 1`
    )
    .get(phone, kind, excludeOrderId, sinceMs);
  return Boolean(row);
}

/** Igual que enqueueWa pero FUERZA el reenvío: si ya existe una fila para ese
 *  (order_id, kind) —sent/failed/canceled/queued— la resetea a 'queued' con el
 *  body/phone nuevos en vez de ignorarla. Para el botón de envío manual del admin. */
export function enqueueWaForce({ orderId, phone, kind, body }) {
  openDb();
  const now = Date.now();
  const id = randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO wa_outbox (id, order_id, phone, kind, body, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, ?)
     ON CONFLICT(order_id, kind) DO UPDATE SET
       status = 'queued', body = excluded.body, phone = excluded.phone,
       last_error = NULL, created_at = excluded.created_at`
  ).run(id, orderId, phone, kind, body, now);
  return true;
}

export function claimWaPending(limit = 5) {
  openDb();
  // Colapso de onboarding ANTES de entregar: si una orden acumuló varios mensajes de
  // onboarding en cola (activación + recordatorios, típico backlog con la PC apagada),
  // el cliente debe recibir UNO solo ("sube tu QR"), no tres seguidos. Se conserva el
  // más reciente (refleja la etapa actual) y se cancela el resto.
  db.prepare(`
    UPDATE wa_outbox SET status = 'canceled'
    WHERE status = 'queued'
      AND kind IN ('activacion','recordatorio_3h','recordatorio_24h')
      AND EXISTS (
        SELECT 1 FROM wa_outbox b
        WHERE b.order_id = wa_outbox.order_id
          AND b.kind IN ('activacion','recordatorio_3h','recordatorio_24h')
          AND b.status = 'queued'
          AND (b.created_at > wa_outbox.created_at
               OR (b.created_at = wa_outbox.created_at AND b.id > wa_outbox.id))
      )
  `).run();
  const rows = db
    .prepare(`SELECT * FROM wa_outbox WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`)
    .all(limit);
  const upd = db.prepare(`UPDATE wa_outbox SET status = 'sending' WHERE id = ? AND status = 'queued'`);
  const claimed = [];
  for (const r of rows) {
    const info = upd.run(r.id);
    if (info.changes > 0) claimed.push({ id: r.id, order_id: r.order_id, phone: r.phone, kind: r.kind, body: r.body });
  }
  return claimed;
}

export function markWaSent(id, ok, error = null, wamid = null) {
  openDb();
  if (ok) {
    // wamid en el MISMO UPDATE: el webhook de statuses de Meta puede llegar en
    // milisegundos y busca la fila por wamid — dos escrituras dejarían ventana.
    db.prepare(`UPDATE wa_outbox SET status = 'sent', sent_at = ?, wamid = COALESCE(?, wamid), attempts = attempts + 1 WHERE id = ?`)
      .run(Date.now(), wamid, id);
  } else {
    db.prepare(`UPDATE wa_outbox SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE id = ?`)
      .run(error ? String(error).slice(0, 500) : null, id);
  }
}

export function requeueStaleWa(maxAgeMs) {
  openDb();
  const cutoff = Date.now() - maxAgeMs;
  const info = db
    .prepare(`UPDATE wa_outbox SET status = 'queued' WHERE status = 'sending' AND created_at <= ?`)
    .run(cutoff);
  return info.changes;
}

export function listWaOutbox() {
  openDb();
  return db.prepare(`SELECT * FROM wa_outbox ORDER BY created_at ASC`).all();
}

export function requeueWa(id) {
  openDb();
  const info = db.prepare(
    `UPDATE wa_outbox SET status = 'queued', last_error = NULL
     WHERE id = ? AND status IN ('failed','canceled')`).run(id);
  return info.changes > 0;
}

export function cancelWa(id) {
  openDb();
  // 'sending' también: un mensaje puede quedar colgado en ese estado si la PC del
  // agente se apagó a mitad (si el agente SÍ lo estaba mandando, su markWaSent
  // posterior lo deja 'sent' de todas formas).
  const info = db.prepare(
    `UPDATE wa_outbox SET status = 'canceled' WHERE id = ? AND status IN ('queued','sending')`).run(id);
  return info.changes > 0;
}

/** Cancela TODOS los mensajes pendientes (queued/sending) de una orden, sin importar
 *  el kind. Usado al ARCHIVAR la orden: una orden archivada no manda nada. */
export function cancelAllPendingWa(orderId) {
  openDb();
  const info = db.prepare(
    `UPDATE wa_outbox SET status = 'canceled' WHERE order_id = ? AND status IN ('queued','sending')`
  ).run(orderId);
  return info.changes;
}

/** Cancela los mensajes PENDIENTES de una orden para ciertos kinds. Incluye los
 *  'sending' colgados (PC apagada): si el agente sí lo estaba enviando, su markWaSent
 *  posterior lo deja 'sent' igual. Usado al subir el QR para matar el onboarding viejo. */
export function cancelPendingWaByKinds(orderId, kinds) {
  openDb();
  if (!kinds?.length) return 0;
  const marks = kinds.map(() => '?').join(',');
  const info = db.prepare(
    `UPDATE wa_outbox SET status = 'canceled'
     WHERE order_id = ? AND kind IN (${marks}) AND status IN ('queued','sending')`
  ).run(orderId, ...kinds);
  return info.changes;
}

// ── Intents del checkout Bre-B propio (QR Nequi de Sonó + match por monto) ────

/**
 * Crea un intent de pago Bre-B para una orden, o REUSA el pendiente vigente de la
 * misma orden (idempotente: si el cliente recarga la página no se duplican intents
 * ni se reinicia la ventana). amount en pesos, ttlMs = ventana de matching.
 */
export function createPaymentIntent({ orderId, amount, ttlMs }) {
  openDb();
  const now = Date.now();
  const existing = db.prepare(
    `SELECT * FROM payment_intents
     WHERE order_id = ? AND status = 'pending' AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(orderId, now);
  if (existing) return existing;
  const intent = {
    id: randomBytes(16).toString('hex'),
    order_id: orderId,
    amount: Math.round(amount),
    status: 'pending',
    bank: null,
    created_at: now,
    expires_at: now + ttlMs,
    paid_at: null,
  };
  db.prepare(
    `INSERT INTO payment_intents (id, order_id, amount, status, created_at, expires_at)
     VALUES (@id, @order_id, @amount, @status, @created_at, @expires_at)`
  ).run(intent);
  return intent;
}

export function getPaymentIntent(id) {
  openDb();
  return db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(id);
}

/**
 * Matchea un pago entrante (a la cuenta de pagos de Sonó) contra los intents
 * pendientes: mismo monto, dentro de la ventana + gracia (el correo del banco
 * tarda unos segundos en llegar). FIFO: si dos intents esperan el mismo monto,
 * gana el más viejo (colisión aceptada: volumen bajo, decisión del dueño jul-2026).
 * Marca el intent 'paid' y lo devuelve, o null si no hay match. better-sqlite3 es
 * sincrónico single-thread → select+update no corre carreras.
 */
export function matchPaymentIntent(amount, { graceMs = 45_000, bank = null } = {}) {
  openDb();
  const now = Date.now();
  const hit = db.prepare(
    `SELECT * FROM payment_intents
     WHERE status = 'pending' AND amount = ? AND expires_at + ? > ?
     ORDER BY created_at ASC LIMIT 1`
  ).get(Math.round(amount), graceMs, now);
  if (!hit) return null;
  db.prepare(
    `UPDATE payment_intents SET status = 'paid', paid_at = ?, bank = ? WHERE id = ?`
  ).run(now, bank, hit.id);
  return { ...hit, status: 'paid', paid_at: now, bank };
}

// ── Settings + heartbeat del agente de WhatsApp (tabla key-value wa_meta) ─────
const WA_SETTINGS_DEFAULTS = {
  enabled: true,
  active_hour_start: 8,
  active_hour_end: 21,
  daily_cap: 200,
  min_delay_ms: 8000,
  max_delay_ms: 20000,
};

export function getWaSettings() {
  const row = db.prepare(`SELECT value FROM wa_meta WHERE key = 'settings'`).get();
  if (!row) return { ...WA_SETTINGS_DEFAULTS };
  try { return { ...WA_SETTINGS_DEFAULTS, ...JSON.parse(row.value) }; }
  catch { return { ...WA_SETTINGS_DEFAULTS }; }
}

// Sanea/clampea los settings antes de persistir: coacciona a número y aplica límites
// sensatos. Evita que un PATCH mal formado (min>max, daily_cap negativo, valores no
// numéricos) rompa el agente de WhatsApp (randDelay daría NaN).
function sanitizeWaSettings(s) {
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const out = {
    enabled: Boolean(s.enabled),
    active_hour_start: clamp(Math.trunc(num(s.active_hour_start, 8)), 0, 23),
    active_hour_end: clamp(Math.trunc(num(s.active_hour_end, 21)), 1, 24),
    daily_cap: clamp(Math.trunc(num(s.daily_cap, 200)), 1, 100000),
    min_delay_ms: clamp(Math.trunc(num(s.min_delay_ms, 8000)), 0, 3600000),
    max_delay_ms: clamp(Math.trunc(num(s.max_delay_ms, 20000)), 0, 3600000),
  };
  // Garantiza min <= max y start < end
  if (out.max_delay_ms < out.min_delay_ms) out.max_delay_ms = out.min_delay_ms;
  if (out.active_hour_end <= out.active_hour_start) out.active_hour_end = Math.min(out.active_hour_start + 1, 24);
  return out;
}

export function setWaSettings(partial) {
  const merged = sanitizeWaSettings({ ...getWaSettings(), ...partial });
  db.prepare(`INSERT INTO wa_meta (key, value) VALUES ('settings', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(merged));
  return merged;
}

export function touchWaAgent() {
  db.prepare(`INSERT INTO wa_meta (key, value) VALUES ('agent_last_seen', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(Date.now()));
}

export function getWaAgentLastSeen() {
  const row = db.prepare(`SELECT value FROM wa_meta WHERE key = 'agent_last_seen'`).get();
  return row ? Number(row.value) : null;
}

/** Actualiza el estado REAL de entrega que reporta el webhook de Meta (statuses).
 *  'failed' además marca la fila como failed con el error, para que el panel no
 *  muestre "Enviado" en mensajes que Meta aceptó pero nunca entregó. */
export function updateWaDeliveryByWamid(wamid, delivery, error = null) {
  openDb();
  // El hilo del chat (wa_inbound, salientes del CRM y plantillas) comparte wamid:
  // actualizarlo siempre para que /soporte-app muestre los chulitos reales.
  const noDegradar = `
     AND (delivery IS NULL
          OR (delivery = 'sent' AND ? IN ('delivered','read'))
          OR (delivery = 'delivered' AND ? = 'read'))`;
  db.prepare(
    delivery === 'failed'
      ? `UPDATE wa_inbound SET delivery = 'failed' WHERE id = ?`
      : `UPDATE wa_inbound SET delivery = ? WHERE id = ?${noDegradar}`
  ).run(...(delivery === 'failed' ? [wamid] : [delivery, wamid, delivery, delivery]));
  if (delivery === 'failed') {
    return db.prepare(
      `UPDATE wa_outbox SET delivery = ?, status = 'failed', last_error = ? WHERE wamid = ?`
    ).run(delivery, error ? String(error).slice(0, 500) : 'meta: failed', wamid).changes;
  }
  // No degradar: read > delivered > sent (los statuses pueden llegar desordenados).
  return db.prepare(
    `UPDATE wa_outbox SET delivery = ? WHERE wamid = ?${noDegradar}`
  ).run(delivery, wamid, delivery, delivery).changes;
}

/** Mensaje del hilo de chat (entrante del webhook o saliente del CRM/plantillas).
 *  Idempotente por id (wamid). direction: 'in' | 'out'. */
export function insertWaInbound({ id, phone, name, type, body, direction = 'in', delivery = null }) {
  openDb();
  const info = db.prepare(
    `INSERT OR IGNORE INTO wa_inbound (id, phone, name, type, body, direction, delivery, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, phone, name || null, type, body || null, direction, delivery, Date.now());
  return info.changes > 0;
}

export function listWaInbound(limit = 100) {
  openDb();
  return db.prepare(`SELECT * FROM wa_inbound ORDER BY received_at DESC LIMIT ?`).all(limit);
}

// ── CRM /soporte-app: conversaciones e hilos ────────────────────────────────────

/** Conversaciones agrupadas por teléfono: último mensaje + no-leídos, recientes primero. */
export function listWaChats(limit = 100) {
  openDb();
  return db.prepare(`
    SELECT phone,
           MAX(received_at) AS last_at,
           (SELECT body FROM wa_inbound b WHERE b.phone = w.phone ORDER BY b.received_at DESC, b.rowid DESC LIMIT 1) AS last_body,
           (SELECT direction FROM wa_inbound b WHERE b.phone = w.phone ORDER BY b.received_at DESC, b.rowid DESC LIMIT 1) AS last_direction,
           (SELECT name FROM wa_inbound b WHERE b.phone = w.phone AND b.name IS NOT NULL ORDER BY b.received_at DESC, b.rowid DESC LIMIT 1) AS name,
           SUM(CASE WHEN direction = 'in' AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
    FROM wa_inbound w
    GROUP BY phone
    ORDER BY last_at DESC
    LIMIT ?`).all(limit);
}

/** Hilo completo de una conversación (ascendente para pintar el chat). */
export function listWaChatMessages(phone, limit = 200) {
  openDb();
  return db.prepare(
    `SELECT id, phone, name, type, body, direction, delivery, read_at, received_at
     FROM wa_inbound WHERE phone = ? ORDER BY received_at DESC, rowid DESC LIMIT ?`
  ).all(phone, limit).reverse();
}

/** Marca leídos todos los entrantes de una conversación. */
export function markWaChatRead(phone) {
  openDb();
  return db.prepare(
    `UPDATE wa_inbound SET read_at = ? WHERE phone = ? AND direction = 'in' AND read_at IS NULL`
  ).run(Date.now(), phone).changes;
}

/** No-leídos totales (badge del panel). */
export function countWaChatUnread() {
  openDb();
  return db.prepare(
    `SELECT COUNT(*) n FROM wa_inbound WHERE direction = 'in' AND read_at IS NULL`
  ).get().n;
}

/** Enviados desde un instante (ms). Lo usan los enviadores de la VM para el tope
 *  diario contra la DB (sobrevive reinicios, a diferencia del contador en RAM).
 *  Cuenta por sent_at y NO por status: un mensaje que el webhook de Meta degradó
 *  a 'failed' IGUAL consumió cupo del día (si contara status='sent', cada fallo
 *  reportado liberaría cupo y el cap se superaría justo cuando Meta rechaza). */
export function countWaSentSince(sinceMs) {
  openDb();
  return db
    .prepare(`SELECT COUNT(*) n FROM wa_outbox WHERE sent_at IS NOT NULL AND sent_at >= ?`)
    .get(sinceMs).n;
}

export function countWaByStatus() {
  const rows = db.prepare(`SELECT status, COUNT(*) n FROM wa_outbox GROUP BY status`).all();
  const out = { queued: 0, sending: 0, sent: 0, failed: 0, canceled: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ---------------------------------------------------------------------------
// UGC applications (convocatoria de creadores)
// ---------------------------------------------------------------------------

const UGC_STATUSES = ['nuevo', 'contactado', 'aprobado', 'descartado'];

export function insertUgcApplication(d = {}) {
  openDb();
  const info = db.prepare(`
    INSERT INTO ugc_applications
      (nombre, whatsapp, comuna, redes, contenido, tipo_local, relacion_local,
       link_local, celular_graba, disponible_7dias, origen, ip, status, created_at)
    VALUES
      (@nombre, @whatsapp, @comuna, @redes, @contenido, @tipo_local, @relacion_local,
       @link_local, @celular_graba, @disponible_7dias, @origen, @ip, 'nuevo', @created_at)
  `).run({
    nombre: d.nombre || null,
    whatsapp: d.whatsapp || null,
    comuna: d.comuna || null,
    redes: d.redes || null,
    contenido: d.contenido || null,
    tipo_local: d.tipo_local || null,
    relacion_local: d.relacion_local || null,
    link_local: d.link_local || null,
    celular_graba: d.celular_graba || null,
    disponible_7dias: d.disponible_7dias || null,
    origen: d.origen || null,
    ip: d.ip || null,
    created_at: Date.now(),
  });
  return info.lastInsertRowid;
}

export function listUgcApplications() {
  openDb();
  return db.prepare('SELECT * FROM ugc_applications ORDER BY created_at DESC LIMIT 500').all();
}

export function countUgcNuevo() {
  openDb();
  return db.prepare(`SELECT COUNT(*) n FROM ugc_applications WHERE status = 'nuevo'`).get().n;
}

export function setUgcStatus(id, status) {
  openDb();
  if (!UGC_STATUSES.includes(status)) return false;
  return db.prepare('UPDATE ugc_applications SET status = ? WHERE id = ?').run(status, id).changes > 0;
}

export function deleteUgcApplication(id) {
  openDb();
  return db.prepare('DELETE FROM ugc_applications WHERE id = ?').run(id).changes > 0;
}
