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
  findConvsToReengage, markReengaged,
} from './support-store.js';

// Mensaje de re-enganche: si el cliente deja de responder ~30s y el último mensaje
// fue del bot, Valeria escribe UNA vez invitando a comprar, con el link al checkout.
const REENGAGE_IDLE_MS = 30_000;
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

    // Modo bot: consultar Gemini con guardarraíl.
    const history = historyForModel(conv.id);

    // El PRIMER mensaje del cliente se responde despacio (como una persona que está
    // leyendo y escribiendo): mínimo ~20s. Así se siente atención humana, no un bot.
    const userTurns = history.filter((m) => m.role === "user").length;
    if (userTurns <= 1) {
      const wait = 20000 + Math.floor(Math.random() * 5000);
      logger.info({ convId: conv.id, wait }, "soporte: delay humano del 1er mensaje");
      await new Promise((r) => setTimeout(r, wait));
    }

    const { answer, escalate, reason } = await askGemini(history, text);

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

    const botMsg = addMessage(conv.id, 'bot', answer);
    // Notificar TODOS los mensajes (aunque el bot ya respondió), para que el dueño esté
    // al tanto de cada conversación. Texto distinto al de escalada para diferenciar.
    await safeNotify({
      title: `💬 ${conv.name || 'Cliente'}`,
      body: text.slice(0, 100),
      url: `/soporte-app/#/conv/${conv.id}`,
      tag: `conv-${conv.id}`,
    });
    return { reply: answer, escalated: false, msgId: botMsg.id, userMsgId: userMsg.id };
  });

  app.get('/soporte/conv/:id/messages', async (req, reply) => {
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    const since = Number(req.query.since) || 0;
    return {
      mode: conv.mode,
      status: conv.status,
      messages: listMessages(conv.id, since).filter(m => m.role !== 'system'),
    };
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

  app.get('/soporte/admin/conversations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return {
      pending: countPending(),
      conversations: listConversations(req.query.filter || 'open'),
    };
  });

  app.get('/soporte/admin/conv/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    clearUnreadAdmin(conv.id);
    return { conversation: conv, messages: listMessages(conv.id, 0).filter(m => m.role !== 'system') };
  });

  // El dueño responde manual. Pone la conversación en modo humano y la saca de pendiente.
  app.post('/soporte/admin/conv/:id/reply', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const conv = getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: 'no encontrada' });
    const text = String((req.body || {}).text || '').trim();
    if (!text) return reply.code(400).send({ error: 'mensaje vacío' });
    touchConversation(conv.id, { mode: 'human', status: 'human' });
    const msg = addMessage(conv.id, 'human', text);
    clearUnreadAdmin(conv.id);
    logger.info({ convId: conv.id }, 'soporte: respuesta humana enviada');
    return { ok: true, message: msg };
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
