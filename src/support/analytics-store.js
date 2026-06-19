// Analítica web ligera y propia (sin terceros). Reusa la misma DB SQLite (openDb()).
//
// Idea: la web manda un "ping" cada pocos segundos mientras la pestaña está visible.
// Cada ping renueva el last_seen de un visitante (cookie/localStorage `vid`) y registra
// la página actual. Con eso calculamos:
//   - visitantes ACTIVOS ahora (last_seen dentro de la ventana de actividad)
//   - vistas de página y sesiones del día
//   - desglose por página, dispositivo y referrer
//
// Tablas:
//   web_visitors
//     vid        TEXT PK   - id anónimo del visitante (lo guarda la web en localStorage)
//     first_seen INTEGER
//     last_seen  INTEGER
//     last_page  TEXT
//     device     TEXT      - 'mobile' | 'desktop'
//     referrer   TEXT      - host de origen (google, instagram, directo…)
//     country    TEXT      - país por cabecera del proxy (si llega), sino null
//     views      INTEGER   - total de pageviews acumuladas del visitante
//
//   web_pageviews   (un registro por navegación de página)
//     id INTEGER PK AUTOINCREMENT, vid TEXT, path TEXT, at INTEGER

import { openDb } from '../storage.js';

// Un visitante se considera "activo" si pingueó en los últimos 70s
// (la web pinguea cada 25s; 70s tolera un par de pings perdidos).
export const ACTIVE_WINDOW_MS = 70_000;

let inited = false;
function db() {
  const d = openDb();
  if (!inited) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS web_visitors (
        vid TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        last_page TEXT,
        device TEXT,
        referrer TEXT,
        country TEXT,
        views INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS web_pageviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vid TEXT NOT NULL,
        path TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pv_at ON web_pageviews(at);
      CREATE INDEX IF NOT EXISTS idx_visitor_seen ON web_visitors(last_seen);
    `);
    inited = true;
  }
  return d;
}

const now = () => Date.now();
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Limita longitud y normaliza un campo de texto que viene del cliente.
function clip(s, n = 200) {
  if (s == null) return null;
  return String(s).slice(0, n);
}

// ---------- Registro (público, lo llama la web) ----------

// Un ping de actividad. `newView` = true cuando es una navegación a una página nueva
// (la web lo marca al cambiar de path); los pings de heartbeat van con newView=false.
export function recordPing({ vid, path, device, referrer, country, newView }) {
  if (!vid) return;
  const t = now();
  path = clip(path, 300);
  device = device === 'mobile' ? 'mobile' : 'desktop';
  referrer = clip(referrer, 120);
  country = clip(country, 8);

  const existing = db().prepare('SELECT vid FROM web_visitors WHERE vid = ?').get(vid);
  if (existing) {
    db().prepare(
      `UPDATE web_visitors SET last_seen = ?, last_page = ?, device = ?
       ${newView ? ', views = views + 1' : ''} WHERE vid = ?`
    ).run(t, path, device, vid);
  } else {
    db().prepare(
      `INSERT INTO web_visitors (vid, first_seen, last_seen, last_page, device, referrer, country, views)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(vid, t, t, path, device, referrer, country, newView ? 1 : 0);
  }

  if (newView) {
    db().prepare('INSERT INTO web_pageviews (vid, path, at) VALUES (?, ?, ?)').run(vid, path, t);
  }
}

// ---------- Consulta (admin) ----------

export function getOverview() {
  const d = db();
  const t = now();
  const dayStart = startOfToday();
  const since24 = t - 24 * 3600_000;

  const activeNow = d.prepare(
    'SELECT COUNT(*) n FROM web_visitors WHERE last_seen >= ?'
  ).get(t - ACTIVE_WINDOW_MS).n;

  const todayVisitors = d.prepare(
    'SELECT COUNT(DISTINCT vid) n FROM web_pageviews WHERE at >= ?'
  ).get(dayStart).n;

  const todayViews = d.prepare(
    'SELECT COUNT(*) n FROM web_pageviews WHERE at >= ?'
  ).get(dayStart).n;

  const views24 = d.prepare(
    'SELECT COUNT(*) n FROM web_pageviews WHERE at >= ?'
  ).get(since24).n;

  // Páginas activas en este momento (qué está mirando la gente que está online).
  const activePages = d.prepare(
    `SELECT last_page page, COUNT(*) n FROM web_visitors
     WHERE last_seen >= ? GROUP BY last_page ORDER BY n DESC LIMIT 10`
  ).all(t - ACTIVE_WINDOW_MS);

  // Top páginas del día por pageviews.
  const topPages = d.prepare(
    `SELECT path page, COUNT(*) n FROM web_pageviews
     WHERE at >= ? GROUP BY path ORDER BY n DESC LIMIT 10`
  ).all(dayStart);

  // Dispositivo (visitantes del día).
  const devices = d.prepare(
    `SELECT device, COUNT(DISTINCT vid) n FROM web_pageviews pv
     JOIN web_visitors v USING (vid)
     WHERE pv.at >= ? GROUP BY device`
  ).all(dayStart);

  // Origen del tráfico (visitantes del día por referrer).
  const referrers = d.prepare(
    `SELECT COALESCE(referrer, 'directo') src, COUNT(DISTINCT vid) n FROM web_pageviews pv
     JOIN web_visitors v USING (vid)
     WHERE pv.at >= ? GROUP BY src ORDER BY n DESC LIMIT 8`
  ).all(dayStart);

  // Vistas por hora de las últimas 24h (para una mini gráfica).
  const byHourRaw = d.prepare(
    `SELECT CAST((? - at) / 3600000 AS INTEGER) h, COUNT(*) n
     FROM web_pageviews WHERE at >= ? GROUP BY h`
  ).all(t, since24);
  const byHour = new Array(24).fill(0);
  for (const r of byHourRaw) { if (r.h >= 0 && r.h < 24) byHour[23 - r.h] = r.n; }

  return {
    activeNow,
    todayVisitors,
    todayViews,
    views24,
    activePages: activePages.map(p => ({ page: p.page || '—', n: p.n })),
    topPages: topPages.map(p => ({ page: p.page || '—', n: p.n })),
    devices,
    referrers,
    byHour, // 24 valores, del más viejo al más reciente
  };
}

// Lista de visitantes activos ahora mismo (para la vista "en vivo").
export function getActiveVisitors() {
  const t = now();
  return db().prepare(
    `SELECT vid, last_page, device, referrer, country, last_seen, views
     FROM web_visitors WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT 50`
  ).all(t - ACTIVE_WINDOW_MS);
}

// Borra pageviews viejos para que la DB no crezca infinito (retención 30 días).
export function pruneOld(days = 30) {
  const cutoff = now() - days * 86400_000;
  db().prepare('DELETE FROM web_pageviews WHERE at < ?').run(cutoff);
  db().prepare('DELETE FROM web_visitors WHERE last_seen < ?').run(cutoff);
}
