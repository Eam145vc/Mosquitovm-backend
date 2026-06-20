// Cola de posts de Instagram PROGRAMADOS. La Graph API NO soporta programar posts de feed,
// así que lo hacemos nosotros: guardamos el post (archivos + caption + fecha) y un job
// periódico publica los que ya vencieron. Persistente en disco (sobrevive reinicios).
//
// Estado de un post: 'pending' → 'published' | 'failed'.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { publishToInstagram } from './instagram.js';

const DATA_DIR = path.dirname(config.DB_PATH);
const QUEUE_FILE = path.join(DATA_DIR, 'ig-queue.json');
// Carpeta donde viven los archivos de los posts programados (no se borran hasta publicar).
const SCHED_MEDIA_DIR = path.join(DATA_DIR, 'ig-scheduled');
fs.mkdirSync(SCHED_MEDIA_DIR, { recursive: true });

function load() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}
function save(list) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(list, null, 2));
}

/**
 * Encola un post programado.
 * @param {Array<{filename:string,type:'image'|'video'}>} files  archivos YA guardados en SCHED_MEDIA_DIR
 * @param {string} caption
 * @param {number} scheduledAt  epoch ms en que debe publicarse
 * @returns {object} el post creado
 */
export function enqueue(files, caption, scheduledAt) {
  const list = load();
  const post = {
    id: crypto.randomBytes(8).toString('hex'),
    files, caption,
    scheduled_at: scheduledAt,
    created_at: Date.now(),
    status: 'pending',
    permalink: null,
    error: null,
  };
  list.push(post);
  save(list);
  logger.info({ id: post.id, at: new Date(scheduledAt).toISOString(), files: files.length }, 'ig: post programado');
  return post;
}

export function list() {
  return load().sort((a, b) => a.scheduled_at - b.scheduled_at);
}

export function remove(id) {
  const all = load();
  const post = all.find((p) => p.id === id);
  if (!post) return false;
  // borrar sus archivos
  for (const f of post.files) {
    try { fs.unlinkSync(path.join(SCHED_MEDIA_DIR, f.filename)); } catch {}
  }
  save(all.filter((p) => p.id !== id));
  return true;
}

export const mediaDir = SCHED_MEDIA_DIR;

// Publica un post pendiente (lo usa el job y el endpoint "publicar ahora").
async function publishPost(post) {
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const items = post.files.map((f) => ({ url: `${base}/ig-scheduled/${f.filename}`, type: f.type }));
  const result = await publishToInstagram({ items, caption: post.caption });
  return result;
}

// Marca el post con el resultado y borra sus archivos si se publicó.
function settle(id, patch) {
  const all = load();
  const post = all.find((p) => p.id === id);
  if (!post) return;
  Object.assign(post, patch);
  if (patch.status === 'published') {
    for (const f of post.files) {
      try { fs.unlinkSync(path.join(SCHED_MEDIA_DIR, f.filename)); } catch {}
    }
  }
  save(all);
}

export async function publishNow(id) {
  const post = load().find((p) => p.id === id);
  if (!post) throw new Error('post no encontrado');
  if (post.status === 'published') throw new Error('ya fue publicado');
  const result = await publishPost(post);
  settle(id, { status: 'published', permalink: result.permalink, published_at: Date.now(), error: null });
  return result;
}

// Job: publica todos los pendientes cuya hora ya pasó. Idempotente (un post a la vez).
let running = false;
export async function runDuePosts() {
  if (running) return;
  running = true;
  try {
    const due = load().filter((p) => p.status === 'pending' && p.scheduled_at <= Date.now());
    for (const post of due) {
      try {
        logger.info({ id: post.id }, 'ig: publicando post programado');
        const result = await publishPost(post);
        settle(post.id, { status: 'published', permalink: result.permalink, published_at: Date.now(), error: null });
      } catch (e) {
        logger.error({ id: post.id, err: e.message }, 'ig: fallo publicar programado');
        settle(post.id, { status: 'failed', error: e.message });
      }
    }
  } finally {
    running = false;
  }
}

// Arranca el scheduler: revisa cada 60s si hay posts por publicar.
export function startScheduler() {
  if (!config.hasInstagram) return;
  runDuePosts();
  setInterval(runDuePosts, 60 * 1000);
  logger.info('ig scheduler iniciado (chequeo cada 60s)');
}
