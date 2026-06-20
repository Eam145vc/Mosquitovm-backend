// Publicar en Instagram con la Graph API (cuenta IG Business vinculada a una página FB).
//
// Flujo de la API (2 pasos):
//   1) POST /{ig-user-id}/media        → crea un "container" con la imagen/video (por URL pública)
//   2) POST /{ig-user-id}/media_publish → publica ese container
//
// IMPORTANTE: Instagram DESCARGA el archivo desde una URL pública (no acepta upload binario
// directo). Por eso el http-server guarda el archivo subido y le pasa su URL pública acá.
//
// Soporta:
//   - Foto única (IMAGE)
//   - Carrusel (CAROUSEL): N containers hijos (is_carousel_item) → container padre → publish
//   - Reel (REELS): video; hay que ESPERAR a que termine de procesarse antes de publicar.

import { config } from './config.js';
import { logger } from './logger.js';

const GRAPH = () => `https://graph.facebook.com/${config.IG_GRAPH_VERSION}`;
const TOKEN = () => config.IG_ACCESS_TOKEN;
const IG_USER = () => config.IG_USER_ID;

// POST a Graph con form-urlencoded; lanza un Error legible con el mensaje de Graph.
async function graphPost(path, params) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN() });
  const res = await fetch(`${GRAPH()}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || `Graph error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function graphGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: TOKEN() });
  const res = await fetch(`${GRAPH()}/${path}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `Graph error ${res.status}`);
  return data;
}

// Espera a que un container de video/reel termine de procesarse (status_code = FINISHED).
// Graph procesa el video async; publicar antes de FINISHED da error. Reintenta con backoff.
async function waitForContainer(creationId, { tries = 30, delayMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const st = await graphGet(creationId, { fields: 'status_code,status' });
    if (st.status_code === 'FINISHED') return;
    if (st.status_code === 'ERROR') throw new Error(`El video falló al procesar: ${st.status || 'ERROR'}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('El video tardó demasiado en procesarse. Probá de nuevo.');
}

// Crea el container de un item suelto (foto o video). Para carrusel, pasar isCarouselItem=true.
async function createMediaContainer({ url, type, caption, isCarouselItem }) {
  const params = {};
  if (type === 'video' || type === 'reel') {
    params.media_type = 'REELS';
    params.video_url = url;
  } else {
    params.image_url = url;
  }
  if (isCarouselItem) params.is_carousel_item = 'true';
  if (caption && !isCarouselItem) params.caption = caption;
  const res = await graphPost(`${IG_USER()}/media`, params);
  return res.id;
}

/**
 * Publica en Instagram.
 * @param {Object} opts
 * @param {Array<{url:string,type:'image'|'video'}>} opts.items  - 1 item = foto/reel; 2+ = carrusel
 * @param {string} [opts.caption]
 * @returns {Promise<{id:string, permalink:string|null}>}
 */
export async function publishToInstagram({ items, caption = '' }) {
  if (!config.hasInstagram) throw new Error('Instagram no configurado (faltan IG_ACCESS_TOKEN / IG_USER_ID)');
  if (!Array.isArray(items) || items.length === 0) throw new Error('No hay archivos para publicar');

  let creationId;

  if (items.length === 1) {
    // Foto o reel único.
    const it = items[0];
    creationId = await createMediaContainer({ url: it.url, type: it.type, caption });
    if (it.type === 'video') await waitForContainer(creationId);
  } else {
    // Carrusel: crear cada hijo, esperar los videos, luego el container padre.
    logger.info({ n: items.length }, 'ig: creando carrusel');
    const childIds = [];
    for (const it of items) {
      const id = await createMediaContainer({ url: it.url, type: it.type, isCarouselItem: true });
      if (it.type === 'video') await waitForContainer(id);
      childIds.push(id);
    }
    const parent = await graphPost(`${IG_USER()}/media`, {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption,
    });
    creationId = parent.id;
  }

  // Publicar el container.
  const pub = await graphPost(`${IG_USER()}/media_publish`, { creation_id: creationId });
  const mediaId = pub.id;

  // Traer el permalink para mostrar el link al post (best-effort).
  let permalink = null;
  try {
    const info = await graphGet(mediaId, { fields: 'permalink' });
    permalink = info.permalink || null;
  } catch (e) {
    logger.warn({ err: e.message }, 'ig: no se pudo traer permalink');
  }

  logger.info({ mediaId, permalink, items: items.length }, 'ig: publicado');
  return { id: mediaId, permalink };
}

// Devuelve datos de la cuenta IG conectada (para verificar config en el panel).
export async function getInstagramAccount() {
  if (!config.hasInstagram) return null;
  const data = await graphGet(IG_USER(), { fields: 'username,name,profile_picture_url,followers_count,media_count' });
  return {
    username: data.username || null,
    name: data.name || null,
    avatar: data.profile_picture_url || null,
    followers: data.followers_count ?? null,
    mediaCount: data.media_count ?? null,
  };
}

// Trae los últimos posts publicados de la cuenta (para la grilla del feed en el panel).
export async function getInstagramMedia(limit = 12) {
  if (!config.hasInstagram) return [];
  const data = await graphGet(`${IG_USER()}/media`, {
    fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
    limit,
  });
  return (data.data || []).map((m) => ({
    id: m.id,
    caption: m.caption || '',
    type: m.media_type,                                   // IMAGE | VIDEO | CAROUSEL_ALBUM
    image: m.media_type === 'VIDEO' ? (m.thumbnail_url || m.media_url) : m.media_url,
    permalink: m.permalink,
    timestamp: m.timestamp,
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
  }));
}
