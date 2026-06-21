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
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_at ON inbox(at DESC);
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
  ]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_plan ON orders(mp_plan_id)');
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
  ]);

  return db;
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

/** Asigna alias + correo de reenvío (cifrado) a una cuenta del método correo-redirigido. */
export function setAccountForward(id, { alias, forwardTo }) {
  openDb();
  db.prepare('UPDATE accounts SET alias = ?, forward_to_enc = ?, updated_at = ? WHERE id = ?')
    .run(alias, forwardTo ? encrypt(forwardTo) : null, Date.now(), id);
}

/** Marca que el banco confirmó el cambio de correo (cierra el onboarding automático). */
export function markChangeConfirmed(id) {
  openDb();
  db.prepare('UPDATE accounts SET change_confirmed = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), id);
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
    'business_name', 'bank', 'address', 'city', 'phone', 'customer_email',
    'qr_path', 'qr_mime', 'email_method', 'mp_plan_id',
    'mp_customer_id', 'mp_card_id', 'mp_payer_email', 'next_charge_at',
  ]);
  const keys = Object.keys(patch).filter(k => allowed.has(k));
  if (keys.length === 0) return false;
  const setSql = keys.map(k => `${k} = @${k}`).join(', ');
  const params = { id, updated_at: Date.now() };
  for (const k of keys) params[k] = patch[k];
  return db.prepare(`UPDATE orders SET ${setSql}, updated_at = @updated_at WHERE id = @id`)
    .run(params).changes > 0;
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

/** Desasigna un device: limpia order_id y vuelve a 'provisionado'. */
export function unassignDevice(spkrId) {
  openDb();
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

/** Guarda un pago detectado. Llamado al anunciar (junto al buffer en memoria). */
export function recordPayment({ accountId, amount, bank, payer }) {
  openDb();
  if (!accountId) return null;
  const at = Date.now();
  const info = db.prepare(
    'INSERT INTO payments (account_id, amount, bank, payer, at) VALUES (?, ?, ?, ?, ?)'
  ).run(accountId, amount ?? null, bank || null, payer || null, at);
  return { id: info.lastInsertRowid, accountId, amount, bank, payer, at };
}

/** Últimos pagos de una cuenta (más recientes primero). */
export function paymentsFor(accountId, limit = 50) {
  openDb();
  if (!accountId) return [];
  return db.prepare(
    'SELECT id, amount, bank, payer, at FROM payments WHERE account_id = ? ORDER BY at DESC LIMIT ?'
  ).all(accountId, limit);
}

// ── Buzón (catch-all) ─────────────────────────────────────────────────────────
// Todo correo que llega al MX se guarda acá para verlo en /admin → Buzón.

/** Guarda un correo entrante. accountId NULL = alias desconocido (catch-all). */
export function saveInboxMail({ alias, accountId = null, from = '', subject = '', text = '', html = '', isPayment = false, messageId = null, references = null }) {
  openDb();
  const at = Date.now();
  // Recortamos el cuerpo para no inflar la DB (el HTML del banco puede ser enorme).
  const t = String(text || '').slice(0, 20000);
  const h = String(html || '').slice(0, 60000);
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

/** Lista correos del buzón (más recientes primero). Por defecto sin el cuerpo (liviano). */
export function listInbox({ limit = 100, includeBody = false } = {}) {
  openDb();
  const cols = includeBody
    ? 'id, alias, account_id, from_addr, subject, text, html, is_payment, seen, replied_at, at'
    : 'id, alias, account_id, from_addr, subject, is_payment, seen, replied_at, at, length(text) AS text_len';
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
