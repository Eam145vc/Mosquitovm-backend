// Vigila el INBOX de Gmail por IMAP IDLE + polling fallback.
// Procesa solo mensajes UNSEEN (no leidos) y los marca como leidos despues
// para evitar duplicados.

import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { logger } from './logger.js';
import { parseEmail } from './parsers/index.js';
import { isDuplicate } from './dedupe.js';
import { refreshAccessToken } from './oauth.js';
import { refreshAccessToken as msRefreshAccessToken } from './oauth-microsoft.js';
import { updateAccountRefresh } from './storage.js';

const MS_IMAP_HOST = 'outlook.office365.com';
const MS_IMAP_PORT = 993;

const POLL_INTERVAL_MS = 3000;   // poll agresivo cada 3s para latencia minima

export class ImapWatcher extends EventEmitter {
  constructor({ id, email, refreshToken, speakerId, authType = 'oauth', provider = 'google', imapHost, imapPort, imapUser, imapPass }) {
    super();
    this.id = id;
    this.email = email;
    this.refreshToken = refreshToken;
    this.speakerId = speakerId || config.SPEAKER_DEVICE_ID;
    this.authType = authType;
    this.provider = provider;
    this.imapHost = imapHost || config.IMAP_HOST;
    this.imapPort = imapPort || config.IMAP_PORT;
    this.imapUser = imapUser || email;
    this.imapPass = imapPass;
    this.client = null;
    this._stopping = false;
    this._pollTimer = null;
    this._processing = false;
    this._lastUid = 0;
    this._reconnectMs = 5000;        // backoff actual de reconexión
    this._reconnectTimer = null;
  }

  // Programa una reconexión con backoff exponencial (5s → 10s → … → 5min máx).
  // Evita que una cuenta con token muerto martille la reconexión cada 5s sin parar.
  _scheduleReconnect() {
    if (this._stopping || this._reconnectTimer) return;
    const delay = this._reconnectMs;
    this._reconnectMs = Math.min(this._reconnectMs * 2, 300000); // tope 5 min
    logger.warn({ id: this.id, delay_ms: delay }, 'imap reconnect scheduled');
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.start().catch(e => {
        logger.error({ id: this.id, err: e.message }, 'imap restart fail');
        this._scheduleReconnect(); // si falla el restart (token muerto), reintentar con más backoff
      });
    }, delay);
  }

  async _getAccessToken() {
    if (this.provider === 'microsoft') {
      const { accessToken, refreshToken } = await msRefreshAccessToken(this.refreshToken);
      // Microsoft rota el refresh token: persistir el nuevo para no perder el acceso.
      if (refreshToken && refreshToken !== this.refreshToken) {
        this.refreshToken = refreshToken;
        try { updateAccountRefresh(this.id, refreshToken); } catch {}
      }
      return accessToken;
    }
    const { accessToken } = await refreshAccessToken(this.refreshToken);
    return accessToken;
  }

  // Servidor IMAP segun cuenta: manual / Gmail OAuth / Microsoft OAuth.
  _serverConfig() {
    if (this.authType === 'imap') return { host: this.imapHost, port: this.imapPort };
    if (this.provider === 'microsoft') return { host: MS_IMAP_HOST, port: MS_IMAP_PORT };
    return { host: config.IMAP_HOST, port: config.IMAP_PORT };
  }

  // Credenciales segun el tipo de cuenta: OAuth (Gmail/Microsoft) o password (IMAP manual).
  async _buildAuth() {
    if (this.authType === 'imap') {
      return { user: this.imapUser, pass: this.imapPass };
    }
    const accessToken = await this._getAccessToken();
    return { user: this.email, accessToken };
  }

  async start() {
    if (this._stopping) return;

    const auth = await this._buildAuth();
    const server = this._serverConfig();

    this.client = new ImapFlow({
      host: server.host,
      port: server.port,
      secure: true,
      auth,
      logger: {
        trace: () => {}, debug: () => {}, info: () => {},
        warn: (o) => logger.warn({ ...o, id: this.id }, 'imap'),
        error: (o) => logger.error({ ...o, id: this.id }, 'imap'),
      },
    });

    this.client.on('error', (err) => logger.error({ id: this.id, err: err.message }, 'imap error'));
    this.client.on('close', () => {
      if (this._stopping) return;
      this._stopPolling();
      this.client = null;          // marcar cliente muerto: corta el _idleLoop viejo
      this._scheduleReconnect();   // reconectar con backoff (no martillea cada 5s)
    });

    await this.client.connect();
    this._reconnectMs = 5000;      // conexión OK → resetear backoff
    logger.info({ id: this.id, email: this.email }, 'imap connected');

    await this.client.mailboxOpen('INBOX', { readOnly: false });
    logger.info({ id: this.id }, 'imap INBOX opened');

    // Inicializar lastUid con el UID actual mas alto, asi no reprocesamos viejos
    try {
      const status = await this.client.status('INBOX', { uidNext: true });
      this._lastUid = (status.uidNext || 1) - 1;
      logger.info({ id: this.id, lastUid: this._lastUid }, 'imap starting from current UID');
    } catch {}

    // Evento 'exists' = IDLE detecto cambios (notificacion push de Gmail)
    this.client.on('exists', async () => {
      if (this._stopping) return;
      this._scan('idle');
    });

    // IDLE en loop
    this._idleLoop();

    // Polling fallback cada 8s
    this._startPolling();
  }

  async _idleLoop() {
    // Guardamos el cliente con el que arrancó este loop. Si idle() falla porque la
    // conexión murió (token expirado, etc.), NO reintentamos sobre el cliente muerto
    // (eso causaba un loop infinito de "idle interrupted" cada 1s que trababa el event
    // loop). Salimos del loop: el evento 'close' dispara la reconexión con backoff.
    const myClient = this.client;
    while (!this._stopping && this.client === myClient) {
      try {
        await this.client.idle();
      } catch (e) {
        if (this._stopping) break;
        logger.warn({ id: this.id, err: e.message }, 'imap idle interrupted; ending idle loop (close will reconnect)');
        break; // no reintentar sobre cliente caído — dejar que 'close' reconecte
      }
    }
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this._scan('poll'), POLL_INTERVAL_MS);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _scan(trigger) {
    if (this._processing || this._stopping || !this.client) return;
    this._processing = true;
    const t0 = Date.now();

    try {
      // Buscar mensajes con UID > lastUid (mas rapido que filtrar UNSEEN despues)
      const range = `${this._lastUid + 1}:*`;
      let count = 0;
      let maxUid = this._lastUid;

      for await (const msg of this.client.fetch(range, { source: true, envelope: true, uid: true }, { uid: true })) {
        if (msg.uid <= this._lastUid) continue; // safety
        maxUid = Math.max(maxUid, msg.uid);
        await this.handleMessage(msg);
        count++;
      }

      if (maxUid > this._lastUid) this._lastUid = maxUid;

      if (count > 0) {
        logger.info({ id: this.id, trigger, count, lastUid: this._lastUid, dur_ms: Date.now() - t0 }, 'scan done');
      }
    } catch (e) {
      logger.error({ id: this.id, trigger, err: e.message }, 'scan failed');
    } finally {
      this._processing = false;
    }
  }

  async handleMessage(msg) {
    try {
      const parsed = await simpleParser(msg.source);
      const messageId = parsed.messageId || msg.envelope?.messageId;
      if (isDuplicate(`${this.id}:${messageId || msg.uid}`)) return;

      const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
      const subject = parsed.subject || '';

      if (config.allowedSenders.length > 0) {
        const ok = config.allowedSenders.some(s => fromAddr.includes(s));
        if (!ok) return;
      }

      const result = parseEmail({ from: fromAddr, subject, text: parsed.text, html: parsed.html });
      if (!result) return;

      logger.info({ id: this.id, uid: msg.uid, fromAddr, subject, ...result }, 'payment detected');
      // accountId (= this.id) es obligatorio para que el pago se persista en La Libreta.
      this.emit('payment', { ...result, accountId: this.id, speakerId: this.speakerId, messageId, from: fromAddr, subject });
    } catch (e) {
      logger.error({ id: this.id, err: e.message }, 'handleMessage failed');
    }
  }

  async stop() {
    this._stopping = true;
    this._stopPolling();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.client) {
      try { await this.client.logout(); } catch {}
      this.client = null;
    }
  }
}
