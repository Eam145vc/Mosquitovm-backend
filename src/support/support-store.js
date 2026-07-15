// Persistencia del bot de soporte. Reusa la misma DB SQLite del backend (openDb()).
//
// Tablas:
//   support_conversations
//     id           TEXT PK   - token aleatorio (lo guarda el widget en localStorage)
//     status       TEXT      - 'bot' (lo maneja el bot) | 'pending' (escalada, espera humano)
//                              | 'human' (el dueño tomó el control) | 'closed'
//     mode         TEXT      - 'bot' | 'human'  (quién responde ahora mismo)
//     name         TEXT      - nombre que dejó el visitante (opcional)
//     contact      TEXT      - correo/teléfono que dejó (opcional)
//     page         TEXT      - URL/sección desde donde abrió el chat
//     unread_admin INTEGER   - mensajes del usuario sin leer por el dueño
//     created_at, updated_at, last_msg_at
//
//   support_messages
//     id INTEGER PK AUTOINCREMENT, conv_id TEXT, role TEXT ('user'|'bot'|'human'|'system'),
//     text TEXT, escalated INTEGER, created_at INTEGER
//
//   push_subs  (suscripciones Web Push del dueño / dispositivos admin)
//     endpoint TEXT PK, p256dh TEXT, auth TEXT, label TEXT, created_at INTEGER

import { randomBytes } from 'node:crypto';
import { openDb } from '../storage.js';

let inited = false;
function db() {
  const d = openDb();
  if (!inited) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS support_conversations (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'bot',
        mode TEXT NOT NULL DEFAULT 'bot',
        name TEXT,
        contact TEXT,
        page TEXT,
        unread_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_msg_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS support_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conv_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        escalated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON support_messages(conv_id, id);
      CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    // Migración idempotente: bandera de re-enganche (el bot escribió 1 vez para
    // recuperar al cliente que dejó de responder; 0 = aún no, 1 = ya lo hizo).
    try { d.exec('ALTER TABLE support_conversations ADD COLUMN reengaged INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* ya existe */ }
    // Migración idempotente: revisión de edición. Sube al editar/borrar un mensaje ya
    // enviado; el widget la compara en cada poll y repinta el historial si cambió.
    try { d.exec('ALTER TABLE support_conversations ADD COLUMN rev INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* ya existe */ }
    inited = true;
  }
  return d;
}

const now = () => Date.now();

// ---------- Conversaciones ----------

export function createConversation({ page, name, contact } = {}) {
  const id = randomBytes(12).toString('hex');
  const t = now();
  db().prepare(`INSERT INTO support_conversations
    (id, status, mode, name, contact, page, unread_admin, created_at, updated_at, last_msg_at)
    VALUES (?, 'bot', 'bot', ?, ?, ?, 0, ?, ?, ?)`)
    .run(id, name || null, contact || null, page || null, t, t, t);
  return getConversation(id);
}

export function getConversation(id) {
  return db().prepare('SELECT * FROM support_conversations WHERE id = ?').get(id) || null;
}

export function touchConversation(id, patch = {}) {
  const fields = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (['status', 'mode', 'name', 'contact', 'page', 'unread_admin'].includes(k)) {
      fields.push(`${k} = ?`); vals.push(v);
    }
  }
  fields.push('updated_at = ?'); vals.push(now());
  vals.push(id);
  db().prepare(`UPDATE support_conversations SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getConversation(id);
}

export function bumpLastMsg(id) {
  db().prepare('UPDATE support_conversations SET last_msg_at = ?, updated_at = ? WHERE id = ?')
    .run(now(), now(), id);
}

export function incUnreadAdmin(id) {
  db().prepare('UPDATE support_conversations SET unread_admin = unread_admin + 1 WHERE id = ?').run(id);
}

export function clearUnreadAdmin(id) {
  db().prepare('UPDATE support_conversations SET unread_admin = 0 WHERE id = ?').run(id);
}

// Lista para el panel admin. filter: 'all' | 'pending' | 'open'.
export function listConversations(filter = 'all', limit = 100) {
  let where = '';
  if (filter === 'pending') where = "WHERE status = 'pending'";
  else if (filter === 'open') where = "WHERE status != 'closed'";
  const rows = db().prepare(
    `SELECT * FROM support_conversations ${where} ORDER BY last_msg_at DESC LIMIT ?`
  ).all(limit);
  // Adjuntar el último mensaje como preview.
  const getLast = db().prepare(
    'SELECT role, text FROM support_messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1'
  );
  return rows.map(r => {
    const last = getLast.get(r.id);
    return { ...r, preview: last ? last.text.slice(0, 120) : '', last_role: last?.role || null };
  });
}

export function countPending() {
  return db().prepare("SELECT COUNT(*) n FROM support_conversations WHERE status = 'pending'").get().n;
}

// ---------- Mensajes ----------

export function addMessage(convId, role, text, { escalated = false } = {}) {
  const t = now();
  const info = db().prepare(
    `INSERT INTO support_messages (conv_id, role, text, escalated, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(convId, role, text, escalated ? 1 : 0, t);
  bumpLastMsg(convId);
  return { id: info.lastInsertRowid, conv_id: convId, role, text, escalated, created_at: t };
}

export function listMessages(convId, sinceId = 0) {
  return db().prepare(
    'SELECT id, role, text, escalated, created_at FROM support_messages WHERE conv_id = ? AND id > ? ORDER BY id ASC'
  ).all(convId, sinceId);
}

export function getMessage(convId, msgId) {
  return db().prepare('SELECT * FROM support_messages WHERE conv_id = ? AND id = ?')
    .get(convId, msgId) || null;
}

function bumpRev(convId) {
  db().prepare('UPDATE support_conversations SET rev = rev + 1, updated_at = ? WHERE id = ?')
    .run(now(), convId);
}

export function editMessage(convId, msgId, text) {
  const r = db().prepare('UPDATE support_messages SET text = ? WHERE conv_id = ? AND id = ?')
    .run(text, convId, msgId);
  if (r.changes) bumpRev(convId);
  return r.changes > 0;
}

export function deleteMessage(convId, msgId) {
  const r = db().prepare('DELETE FROM support_messages WHERE conv_id = ? AND id = ?')
    .run(convId, msgId);
  if (r.changes) bumpRev(convId);
  return r.changes > 0;
}

// Historial en el formato que espera gemini.js ({role:'user'|'bot', text}).
export function historyForModel(convId) {
  return db().prepare(
    "SELECT role, text FROM support_messages WHERE conv_id = ? AND role IN ('user','bot','human') ORDER BY id ASC"
  ).all(convId).map(m => ({ role: m.role === 'user' ? 'user' : 'bot', text: m.text }));
}

// ---------- Re-enganche (recuperar al cliente que dejó de responder) ----------
// Devuelve las conversaciones donde: el bot está al mando (no humano, no cerrada),
// el ÚLTIMO mensaje es del bot (la pelota está en el cliente), pasaron >= idleMs
// desde ese mensaje, y aún NO se reenganchó (reengaged = 0). Solo se hace 1 vez.
export function findConvsToReengage(idleMs) {
  const cutoff = now() - idleMs;
  return db().prepare(
    `SELECT c.id FROM support_conversations c
       WHERE c.mode = 'bot' AND c.status != 'closed' AND c.reengaged = 0
         AND c.last_msg_at <= ?
         AND (SELECT role FROM support_messages m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) = 'bot'`
  ).all(cutoff).map(r => r.id);
}

export function markReengaged(id) {
  db().prepare('UPDATE support_conversations SET reengaged = 1, updated_at = ? WHERE id = ?')
    .run(now(), id);
}

// ---------- Push subs ----------

export function savePushSub({ endpoint, p256dh, auth, label }) {
  db().prepare(
    `INSERT INTO push_subs (endpoint, p256dh, auth, label, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(endpoint, p256dh, auth, label || null, now());
}

export function listPushSubs() {
  return db().prepare('SELECT * FROM push_subs').all();
}

export function deletePushSub(endpoint) {
  db().prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
}
