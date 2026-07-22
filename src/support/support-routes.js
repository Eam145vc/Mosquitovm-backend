// Rutas del bot de soporte. Se registran sobre el mismo Fastify del backend.
//
// PÚBLICO (lo usa el widget de la web, sin auth):
//   POST /soporte/conv                 - crea conversación, devuelve {id}
//   POST /soporte/conv/:id/msg         - envía mensaje del usuario; responde bot o escala
//   GET  /soporte/conv/:id/messages    - poll de mensajes nuevos (?since=ID)
//   GET  /soporte/vapid-public         - clave pública VAPID (para el PWA admin)
//   POST /soporte/track                - ping de analítica web (visitantes/páginas)
//
// ADMIN (Bearer ADMIN_TOKEN; lo usa la PWA del iPhone):
//   GET  /soporte/admin/conversations  - lista (?filter=pending|open|all)
//   GET  /soporte/admin/analytics      - resumen de visitas (activos ahora, hoy, top páginas…)
//   GET  /soporte/admin/analytics/live - lista de visitantes activos en este momento
//   GET  /soporte/admin/conv/:id       - detalle + mensajes
//   POST /soporte/admin/conv/:id/reply - el dueño responde manual (pone mode=human)
//   POST /soporte/admin/conv/:id/msg/:msgId/edit   - { text } corrige un mensaje enviado (bot/human)
//   POST /soporte/admin/conv/:id/msg/:msgId/delete - borra un mensaje enviado (bot/human)
//   POST /soporte/admin/conv/:id/mode  - { mode: 'bot'|'human' } tomar/soltar el control
//   POST /soporte/admin/conv/:id/close - cerrar conversación
//   POST /soporte/admin/push/subscribe - registrar suscripción Web Push del iPhone
//   POST /soporte/admin/push/test      - manda un push de prueba
//
// El dueño puede intervenir cuando quiera: al poner mode=human el bot deja de responder
// en esa conversación hasta que vuelva a mode=bot.

import { config } from '../config.js';
import { logger } from '../logger.js';
import { askGemini, ESCALATION_MESSAGE } from './gemini.js';
import { pushEnabled, notifyAdmins } from './webpush.js';
import {
  createConversation, getConversation, touchConversation, clearUnreadAdmin, incUnreadAdmin,
  addMessage, listMessages, historyForModel, listConversations, countPending, savePushSub,
  findConvsToReengage, markReengaged, getMessage, editMessage, deleteMessage,
} from './support-store.js';
// Canal WhatsApp (Cloud API oficial): las conversaciones del número de Sonó se
// integran a ESTE panel con id 'wa:<telefono>' — un solo lugar para atender todo.
import { listWaChats, listWaChatMessages, markWaChatRead, insertWaInbound, listOrders, getWaMedia, setWaInboundMedia } from '../storage.js';
import { normalizePhoneCO } from '../wa-enqueue.js';
import { sendCloudText, sendCloudImage } from '../wa-cloud.js';
import { createReadStream, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setMessageMedia } from './support-store.js';

// Imágenes que sube el CLIENTE en el chat web: archivo local junto a la DB.
const SOPORTE_MEDIA_DIR = join(dirname(config.DB_PATH || './data/db.sqlite'), 'soporte-media');
const IMG_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

// Mensaje de re-enganche: si el cliente deja de responder 5 min y el último mensaje
// fue del bot, Valeria escribe UNA vez invitando a comprar, con el link al checkout.
// (Antes 45s: se sentía afanado/robótico. Subido a 5 min, jul-2026.)
const REENGAGE_IDLE_MS = 5 * 60_000;
const REENGAGE_MESSAGE =
  '¿Sigues por ahí? 👀 Si te animas, puedes pedir tu Sonó en un par de minutos acá: ' +
  'https://sono.lat/checkout — cualquier duda, me dices y te ayudo. 🙂';
import { recordPing, getOverview, getActiveVisitors, pruneOld } from './analytics-store.js';

// Límite simple anti-spam por conversación (mensajes por minuto).
const rate = new Map();
function tooFast(convId) {
  const t = Date.now();
  const arr = (rate.get(convId) || []).filter(x => t - x < 60_000);
  arr.push(t);
  rate.set(convId, arr);
  return arr.length > 20;
}

export function registerSupportRoutes(app) {
  const requireAdmin = (req, reply) => {
    if (!config.ADMIN_TOKEN) { reply.code(503).send({ error: 'admin disabled' }); return false; }
    if ((req.headers.authorization || '') !== `Bearer ${config.ADMIN_TOKEN}`) {
      reply.code(401).send({ error: 'unauthorized' }); return false;
    }
    return true;
  };

  // ---------------------------------------------------------------- PÚBLICO

  app.post('/soporte/conv', async (req) => {
    const { page, name, contact } = req.body || {};
    const conv = createConversation({ page, name, contact });
    // SIN saludo automático: Valeria no escribe sola. Responde recién cuando el cliente
    // manda su primer mensaje (se siente más humano y evita mensajes "de la nada").
    return { id: conv.id };
  });

  app.post('/soporte/conv/:id/msg', async (req, reply) => {
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'conversación no encontrada' });
    if (conv.status === 'closed') return reply.code(409).send({ error: 'conversación cerrada' });

    const text = String((req.body || {}).text || '').trim();
    if (!text) return reply.code(400).send({ error: 'mensaje vacío' });
    if (text.length > 2000) return reply.code(413).send({ error: 'mensaje muy largo' });
    if (tooFast(conv.id)) return reply.code(429).send({ error: 'demasiados mensajes, espera un momento' });

    // Guardar mensaje del usuario y marcar no leído para el admin.
    const userMsg = addMessage(conv.id, 'user', text);
    incUnreadAdmin(conv.id);

    // Si el dueño tomó el control (mode=human) → el bot NO responde. Solo notifica.
    if (conv.mode === 'human') {
      await safeNotify({
        title: `💬 ${conv.name || 'Cliente'} escribió`,
        body: text.slice(0, 120),
        url: `/soporte-app/#/conv/${conv.id}`,
        tag: `conv-${conv.id}`,
      });
      return { reply: null, mode: 'human', userMsgId: userMsg.id };
    }

    // ¿Este handler sigue atendiendo el ÚLTIMO mensaje del cliente? Si el cliente
    // escribió otra vez durante una espera (o mientras Gemini generaba), este handler
    // CALLA: el handler del mensaje más reciente responde UNA sola vez con todo el
    // contexto. Evita la doble respuesta desordenada (bug del saludo tardío, jul-2026).
    const isLastUserMsg = () => {
      const users = listMessages(conv.id, 0).filter((m) => m.role === 'user');
      return users.length === 0 || users[users.length - 1].id === userMsg.id;
    };

    const userTurns = historyForModel(conv.id).filter((m) => m.role === "user").length;

    // El PRIMER mensaje del cliente se responde despacio (como una persona que está
    // leyendo y escribiendo): mínimo ~20s. Los siguientes llevan un cooldown corto que
    // agrupa ráfagas: si el cliente manda 2-3 mensajes seguidos, responde solo el último.
    const wait = userTurns <= 1 ? 20000 + Math.floor(Math.random() * 5000) : 6000;
    logger.info({ convId: conv.id, wait, userTurns }, "soporte: ventana antes de responder");
    await new Promise((r) => setTimeout(r, wait));
    if (!isLastUserMsg()) {
      logger.info({ convId: conv.id, userMsgId: userMsg.id }, "soporte: superseded, no respondo");
      return { reply: null, superseded: true, userMsgId: userMsg.id };
    }

    // El historial se arma DESPUÉS de la ventana: incluye lo que llegó mientras esperábamos.
    const history = historyForModel(conv.id);
    const { answer, escalate, reason } = await askGemini(history, text);

    // Re-chequear: el cliente pudo escribir mientras Gemini generaba.
    if (!isLastUserMsg()) {
      logger.info({ convId: conv.id, userMsgId: userMsg.id }, "soporte: superseded post-Gemini, no respondo");
      return { reply: null, superseded: true, userMsgId: userMsg.id };
    }

    if (escalate || !answer) {
      // El bot NO inventa: escala al humano.
      touchConversation(conv.id, { status: 'pending' });
      const botMsg = addMessage(conv.id, 'bot', ESCALATION_MESSAGE, { escalated: true });
      logger.info({ convId: conv.id, reason }, 'soporte: escalado a humano');
      await safeNotify({
        title: '🔔 El bot necesita tu ayuda',
        body: `${conv.name ? conv.name + ': ' : ''}${text.slice(0, 100)}`,
        url: `/soporte-app/#/conv/${conv.id}`,
        tag: `conv-${conv.id}`,
      });
      return { reply: ESCALATION_MESSAGE, escalated: true, msgId: botMsg.id, userMsgId: userMsg.id };
    }

    // PRIMER mensaje: Valeria primero SE PRESENTA (mensaje corto) y la respuesta real
    // llega ~10s después como un segundo mensaje (el widget muestra "escribiendo…" en
    // el medio, vía la bandera `more`). Se siente como una persona que saluda y luego
    // contesta. El prompt le prohíbe a Gemini saludar, así no se duplica el "¡Hola!".
    if (userTurns <= 1) {
      const saludo = '¡Hola! Soy Valeria, del equipo de Sonó 👋';
      const helloMsg = addMessage(conv.id, 'bot', saludo);
      setTimeout(() => {
        try {
          // Si el cliente escribió de nuevo en estos 10s, la respuesta quedó vieja:
          // no la mandamos; el handler del mensaje nuevo responde con todo el contexto.
          if (!isLastUserMsg()) return;
          addMessage(conv.id, 'bot', answer);
        }
        catch (e) { logger.warn({ convId: conv.id, err: e.message }, 'no se pudo guardar la respuesta diferida'); }
      }, 10_000);
      // Sin push: el bot responde solo (no molestar). Solo se notifica si escala o
      // si el dueño ya tiene el control de la conversación (decisión del usuario jul-2026).
      return { reply: saludo, escalated: false, msgId: helloMsg.id, userMsgId: userMsg.id, more: true };
    }

    const botMsg = addMessage(conv.id, 'bot', answer);
    // SIN push: el bot respondió solo y bien → no molestar. El dueño solo recibe
    // notificación del chat web cuando el bot ESCALA o cuando él tiene el control
    // (modo humano). WhatsApp entrante sí notifica siempre.
    return { reply: answer, escalated: false, msgId: botMsg.id, userMsgId: userMsg.id };
  });

  app.get('/soporte/conv/:id/messages', async (req, reply) => {
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    const since = Number(req.query.since) || 0;
    return {
      mode: conv.mode,
      status: conv.status,
      rev: conv.rev || 0,
      messages: listMessages(conv.id, since).filter(m => m.role !== 'system'),
    };
  });

  // Formulario "el agente no llegó": el widget lo abre a los 2 min de una escalación
  // sin respuesta humana. El mensaje queda en la conversación (rastro en el panel),
  // notifica por push y se manda a hola@sono.lat por el MX saliente firmado.
  const contactSent = new Set(); // 1 formulario por conversación (anti doble-submit)
  app.post('/soporte/conv/:id/contact', async (req, reply) => {
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'conversación no encontrada' });
    if (contactSent.has(conv.id)) return { ok: true, already: true };

    const name = String((req.body || {}).name || '').trim().slice(0, 120);
    const contact = String((req.body || {}).contact || '').trim().slice(0, 160);
    const message = String((req.body || {}).message || '').trim();
    if (!message) return reply.code(400).send({ error: 'mensaje vacío' });
    if (message.length > 3000) return reply.code(413).send({ error: 'mensaje muy largo' });
    contactSent.add(conv.id);

    addMessage(conv.id, 'user',
      `📮 Formulario de contacto (el agente no alcanzó a unirse)\n` +
      `Nombre: ${name || '—'}\nContacto: ${contact || '—'}\n\n${message}`);
    touchConversation(conv.id, { status: 'pending' });

    let mailed = false;
    if (config.MX_SEND_API_URL && config.EMAIL_WEBHOOK_SECRET) {
      try {
        const resp = await fetch(`${config.MX_SEND_API_URL.replace(/\/$/, '')}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-sono-secret': config.EMAIL_WEBHOOK_SECRET },
          body: JSON.stringify({
            fromLocal: 'hola',
            fromName: 'Soporte Sonó',
            to: 'hola@sono.lat',
            subject: `📮 Chat sin agente — ${name || 'visitante'}`,
            text: [
              'Un cliente escaló en el chat y ningún agente se unió en 2 minutos.',
              '',
              `Nombre: ${name || '—'}`,
              `Contacto: ${contact || '—'}`,
              '',
              'Mensaje:',
              message,
              '',
              `Conversación: https://sono.lat/soporte-app/#/conv/${conv.id}`,
            ].join('\n'),
          }),
        });
        mailed = resp.ok;
      } catch (e) {
        logger.warn({ convId: conv.id, err: e.message }, 'soporte: no se pudo enviar el formulario por correo');
      }
    }
    await safeNotify({
      title: `📮 ${name || 'Cliente'} dejó un mensaje (sin agente)`,
      body: message.slice(0, 120),
      url: `/soporte-app/#/conv/${conv.id}`,
      tag: `conv-${conv.id}`,
    });
    logger.info({ convId: conv.id, mailed }, 'soporte: formulario de contacto recibido');
    return { ok: true, mailed };
  });

  // El CLIENTE sube una imagen al chat (multipart: file [+ caption]). El bot no ve
  // imágenes → si estaba al mando, escala a humano con un mensaje honesto.
  app.post('/soporte/conv/:id/media', async (req, reply) => {
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'conversación no encontrada' });
    if (conv.status === 'closed') return reply.code(409).send({ error: 'conversación cerrada' });
    if (tooFast(conv.id)) return reply.code(429).send({ error: 'demasiados mensajes, espera un momento' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'falta el archivo' });
    const mime = part.mimetype || '';
    if (!IMG_EXT[mime]) return reply.code(415).send({ error: 'solo imágenes (jpg, png, webp, gif)' });
    const buf = await part.toBuffer();
    if (buf.length > 5 * 1024 * 1024) return reply.code(413).send({ error: 'máximo 5MB' });
    const caption = String(part.fields?.caption?.value || '').trim().slice(0, 500);

    mkdirSync(SOPORTE_MEDIA_DIR, { recursive: true });
    const userMsg = addMessage(conv.id, 'user', caption || '[imagen]');
    const file = join(SOPORTE_MEDIA_DIR, `${conv.id}-${userMsg.id}${IMG_EXT[mime]}`);
    writeFileSync(file, buf);
    setMessageMedia(conv.id, userMsg.id, file, mime);
    incUnreadAdmin(conv.id);

    // Valeria no puede ver imágenes: escalar a humano (solo si el bot estaba al mando).
    let botReply = null, escalated = false;
    if (conv.mode !== 'human') {
      touchConversation(conv.id, { status: 'pending' });
      escalated = true;
      botReply = addMessage(conv.id, 'bot',
        'Recibí tu imagen 🙌 Se la paso a un agente del equipo para revisarla, dame un momentico.',
        { escalated: true });
    }
    await safeNotify({
      title: `🖼 ${conv.name || 'Cliente'} envió una imagen`,
      body: caption || 'Imagen en el chat de la web',
      url: `/soporte-app/#/conv/${conv.id}`,
      tag: `conv-${conv.id}`,
    });
    logger.info({ convId: conv.id, msgId: userMsg.id }, 'soporte: imagen del cliente recibida');
    return {
      ok: true, userMsgId: userMsg.id,
      reply: botReply?.text || null, msgId: botReply?.id || null, escalated,
    };
  });

  // Imagen de un mensaje del chat web. Público: quien tiene el id de la conversación
  // (token aleatorio de 12 bytes en localStorage del cliente) puede ver sus imágenes —
  // el mismo nivel de acceso que ya da /soporte/conv/:id/messages.
  app.get('/soporte/conv/:id/media/:msgId', async (req, reply) => {
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    const msg = getMessage(conv.id, Number(req.params.msgId));
    if (!msg?.media_path || !existsSync(msg.media_path)) return reply.code(404).send({ error: 'sin media' });
    reply.header('Content-Type', msg.media_mime || 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(createReadStream(msg.media_path));
  });

  app.get('/soporte/vapid-public', async () => ({
    publicKey: config.VAPID_PUBLIC_KEY || null,
    pushEnabled: pushEnabled(),
  }));

  // Ping de analítica web. Lo manda la web (sin auth) cada ~25s mientras la pestaña
  // está visible, y al cambiar de página (newView=true). Es fire-and-forget.
  app.post('/soporte/track', async (req, reply) => {
    const b = req.body || {};
    if (!b.vid) return reply.code(204).send();
    // País por cabecera del proxy/CDN si existe (Cloudflare/Contabo proxy), sino null.
    const country =
      req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || null;
    recordPing({
      vid: String(b.vid).slice(0, 64),
      path: b.path,
      device: b.device,
      referrer: b.referrer,
      country,
      newView: Boolean(b.newView),
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- ADMIN

  // Nombre a mostrar de un chat de WhatsApp: negocio de la orden con ese teléfono,
  // o el nombre de perfil de WhatsApp, o el número.
  const negocioPorTelefono = () => {
    const m = new Map();
    for (const o of listOrders()) {
      const p = normalizePhoneCO(o.phone);
      if (p && o.business_name && !m.has(p)) m.set(p, o.business_name);
    }
    return m;
  };

  // Chats de WhatsApp con la MISMA forma que las conversaciones del widget web.
  // status: 'pending' con no-leídos (suena en el filtro Pendientes); si no, 'open'.
  const waConversations = (filter) => {
    const negocios = negocioPorTelefono();
    return listWaChats(150)
      .filter((c) => (filter === 'pending' ? c.unread > 0 : true))
      .map((c) => ({
        id: `wa:${c.phone}`,
        channel: 'wa',
        name: negocios.get(c.phone) || c.name || `+${c.phone}`,
        contact: `+${c.phone}`,
        status: c.unread > 0 ? 'pending' : 'open',
        mode: 'human',
        preview: (c.last_direction === 'out' ? 'Tú: ' : '') + (c.last_body || '…'),
        last_msg_at: c.last_at,
        unread_admin: c.unread,
      }));
  };

  const isWaId = (id) => String(id).startsWith('wa:');
  const waPhone = (id) => String(id).slice(3).replace(/\D/g, '');

  app.get('/soporte/admin/conversations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const filter = req.query.filter || 'open';
    const wa = waConversations(filter);
    const web = listConversations(filter).map((c) => ({ ...c, channel: 'web' }));
    return {
      pending: countPending() + wa.filter((c) => c.unread_admin > 0).length,
      conversations: [...web, ...wa].sort((a, b) => (b.last_msg_at || 0) - (a.last_msg_at || 0)),
    };
  });

  app.get('/soporte/admin/conv/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (isWaId(req.params.id)) {
      const phone = waPhone(req.params.id);
      markWaChatRead(phone); // abrir = leer
      const negocios = negocioPorTelefono();
      const msgs = listWaChatMessages(phone, 300);
      const name = negocios.get(phone) || msgs.findLast?.((m) => m.name)?.name || `+${phone}`;
      return {
        conversation: {
          id: `wa:${phone}`, channel: 'wa', name, contact: `+${phone}`,
          page: 'WhatsApp', mode: 'human', status: 'open',
        },
        // Mapeo al formato del panel: entrante=user, plantilla automática=bot, tú=human.
        messages: msgs.map((m) => ({
          id: m.id,
          role: m.direction === 'in' ? 'user' : (m.type === 'template' ? 'bot' : 'human'),
          text: m.body || `[${m.type}]`,
          ts: m.received_at,
          delivery: m.delivery,
          type: m.type,
          media: Boolean(m.has_media),
          mime: m.media_mime || null,
          media_url: m.has_media ? `/soporte/admin/wa-media/${encodeURIComponent(m.id)}` : null,
        })),
      };
    }
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    clearUnreadAdmin(conv.id);
    return {
      conversation: { ...conv, channel: 'web' },
      messages: listMessages(conv.id, 0).filter(m => m.role !== 'system').map((m) => ({
        ...m,
        ts: m.created_at,
        media: Boolean(m.has_media),
        mime: m.media_mime || null,
        media_url: m.has_media ? `/soporte/conv/${conv.id}/media/${m.id}` : null,
      })),
    };
  });

  // El dueño responde manual. Pone la conversación en modo humano y la saca de pendiente.
  app.post('/soporte/admin/conv/:id/reply', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const text = String((req.body || {}).text || '').trim();
    if (!text) return reply.code(400).send({ error: 'mensaje vacío' });
    if (isWaId(req.params.id)) {
      const phone = waPhone(req.params.id);
      try {
        const wamid = await sendCloudText(phone, text);
        const id = wamid || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        insertWaInbound({ id, phone, name: null, type: 'text', body: text, direction: 'out' });
        logger.info({ phone }, 'soporte: respuesta WhatsApp enviada');
        return { ok: true, message: { id, role: 'human', text, ts: Date.now() } };
      } catch (e) {
        const ventana = e.message.startsWith('VENTANA_CERRADA');
        logger.warn({ phone, err: e.message }, 'soporte: respuesta WhatsApp falló');
        return reply.code(ventana ? 409 : 502).send({
          error: ventana
            ? 'Pasaron más de 24h desde el último mensaje del cliente: WhatsApp solo permite reabrir con una plantilla (botón de reenviar en la orden del /admin).'
            : `No se pudo enviar: ${e.message}`,
        });
      }
    }
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    touchConversation(conv.id, { mode: 'human', status: 'human' });
    const msg = addMessage(conv.id, 'human', text);
    clearUnreadAdmin(conv.id);
    logger.info({ convId: conv.id }, 'soporte: respuesta humana enviada');
    return { ok: true, message: msg };
  });

  // Archivo de media de un mensaje de WhatsApp (imagen/audio/video/documento).
  // El panel lo pide con fetch autenticado y lo pinta como blob.
  app.get('/soporte/admin/wa-media/:msgId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const m = getWaMedia(req.params.msgId);
    if (!m?.media_path || !existsSync(m.media_path)) return reply.code(404).send({ error: 'sin media' });
    reply.header('Content-Type', m.media_mime || 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(createReadStream(m.media_path));
  });

  // Enviar una IMAGEN a un chat de WhatsApp (multipart: file + caption opcional).
  app.post('/soporte/admin/conv/:id/media', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!isWaId(req.params.id)) return reply.code(400).send({ error: 'solo disponible en chats de WhatsApp' });
    const phone = waPhone(req.params.id);
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'falta el archivo' });
    const mime = part.mimetype || '';
    if (!mime.startsWith('image/')) return reply.code(415).send({ error: 'solo imágenes por ahora' });
    const buf = await part.toBuffer();
    if (buf.length > 5 * 1024 * 1024) return reply.code(413).send({ error: 'máximo 5MB (límite de WhatsApp)' });
    const caption = String(part.fields?.caption?.value || '').trim();
    try {
      const { wamid, path: mediaPath, mime: outMime } = await sendCloudImage(phone, buf, mime, caption);
      const id = wamid || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      insertWaInbound({ id, phone, name: null, type: 'image', body: caption || '[image]', direction: 'out' });
      setWaInboundMedia(id, mediaPath, outMime);
      logger.info({ phone }, 'soporte: imagen WhatsApp enviada');
      return { ok: true, id };
    } catch (e) {
      const ventana = e.message.startsWith('VENTANA_CERRADA');
      logger.warn({ phone, err: e.message }, 'soporte: imagen WhatsApp falló');
      return reply.code(ventana ? 409 : 502).send({
        error: ventana
          ? 'Pasaron más de 24h desde el último mensaje del cliente: WhatsApp solo permite reabrir con una plantilla.'
          : `No se pudo enviar la imagen: ${e.message}`,
      });
    }
  });

  // Corregir un mensaje ya enviado (bot o human; los del cliente no se tocan).
  // Sube `rev` en la conversación → el widget del cliente repinta el historial.
  app.post('/soporte/admin/conv/:id/msg/:msgId/edit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    const msg = getMessage(conv.id, Number(req.params.msgId));
    if (!msg) return reply.code(404).send({ error: 'mensaje no encontrado' });
    if (msg.role === 'user' || msg.role === 'system') {
      return reply.code(403).send({ error: 'solo se editan mensajes del bot o tuyos' });
    }
    const text = String((req.body || {}).text || '').trim();
    if (!text) return reply.code(400).send({ error: 'mensaje vacío' });
    if (text.length > 2000) return reply.code(413).send({ error: 'mensaje muy largo' });
    editMessage(conv.id, msg.id, text);
    logger.info({ convId: conv.id, msgId: msg.id }, 'soporte: mensaje editado');
    return { ok: true };
  });

  app.post('/soporte/admin/conv/:id/msg/:msgId/delete', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    const msg = getMessage(conv.id, Number(req.params.msgId));
    if (!msg) return reply.code(404).send({ error: 'mensaje no encontrado' });
    if (msg.role === 'user' || msg.role === 'system') {
      return reply.code(403).send({ error: 'solo se borran mensajes del bot o tuyos' });
    }
    deleteMessage(conv.id, msg.id);
    logger.info({ convId: conv.id, msgId: msg.id }, 'soporte: mensaje borrado');
    return { ok: true };
  });

  // Tomar (human) o soltar (bot) el control de una conversación.
  app.post('/soporte/admin/conv/:id/mode', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    const mode = (req.body || {}).mode === 'human' ? 'human' : 'bot';
    const status = mode === 'human' ? 'human' : 'bot';
    touchConversation(conv.id, { mode, status });
    if (mode === 'bot') {
      addMessage(conv.id, 'system', 'El asistente automático retomó esta conversación.');
    }
    return { ok: true, mode };
  });

  app.post('/soporte/admin/conv/:id/close', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    touchConversation(conv.id, { status: 'closed' });
    return { ok: true };
  });

  // ---------- Analítica web (admin) ----------

  app.get('/soporte/admin/analytics', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return getOverview();
  });

  app.get('/soporte/admin/analytics/live', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { visitors: getActiveVisitors() };
  });

  // Registrar la suscripción Web Push del iPhone (PWA admin).
  app.post('/soporte/admin/push/subscribe', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { endpoint, keys, label } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return reply.code(400).send({ error: 'suscripción inválida' });
    }
    savePushSub({ endpoint, p256dh: keys.p256dh, auth: keys.auth, label });
    logger.info({ label }, 'push sub admin registrada');
    return { ok: true };
  });

  app.post('/soporte/admin/push/test', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const r = await notifyAdmins({
      title: '✅ Notificaciones activas',
      body: 'Tu iPhone ya recibe avisos del soporte de Sonó.',
      url: '/soporte-app/',
      tag: 'sono-test',
    });
    return { ok: true, sent: r.sent };
  });

  // Limpieza de analítica vieja: una vez al arrancar y luego cada 12h.
  try { pruneOld(30); } catch (e) { logger.warn({ err: e.message }, 'pruneOld inicial falló'); }
  setInterval(() => {
    try { pruneOld(30); } catch (e) { logger.warn({ err: e.message }, 'pruneOld falló'); }
  }, 12 * 3600_000).unref?.();

  // Job de re-enganche: cada 10s busca conversaciones donde el cliente dejó de
  // responder (>= 30s, último mensaje del bot, modo bot) y aún no se reengancharon.
  // Escribe UN mensaje invitando a comprar con el link al checkout. Solo 1 vez por
  // conversación (markReengaged). El widget lo recibe por su polling (también cuando
  // está minimizado, donde dispara sonido + badge).
  setInterval(() => {
    try {
      const ids = findConvsToReengage(REENGAGE_IDLE_MS);
      for (const id of ids) {
        const conv = getConversation(id);
        if (!conv || conv.mode === 'human' || conv.status === 'closed') { markReengaged(id); continue; }
        addMessage(id, 'bot', REENGAGE_MESSAGE);
        markReengaged(id);
        logger.info({ convId: id }, 'soporte: re-enganche enviado');
      }
    } catch (e) { logger.warn({ err: e.message }, 're-enganche falló'); }
  }, 10_000).unref?.();

  logger.info({ push: pushEnabled(), gemini: Boolean(config.GEMINI_API_KEY) }, 'rutas de soporte registradas');
}

// Notificación que nunca tumba el flujo si el push falla.
async function safeNotify(payload) {
  try { await notifyAdmins(payload); }
  catch (e) { logger.warn({ err: e.message }, 'notifyAdmins fallo'); }
}
