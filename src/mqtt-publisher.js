// Cliente MQTT que publica comandos voice al speaker.
// Soporta multiples speakers: el topic se calcula del speakerId que viene
// en cada publishVoice().

import mqtt from 'mqtt';
import { config } from './config.js';
import { logger } from './logger.js';

let client = null;
let onStatus = null; // callback(spkrId, info) para auto-provisioning

/** Registra el handler que recibe la telemetría de los speakers (speakers/+/status). */
export function onSpeakerStatus(cb) { onStatus = cb; }

const STATUS_TOPIC = 'speakers/+/status';

export function connect() {
  if (client) return client;

  logger.info({ url: config.MQTT_URL }, 'mqtt connecting');
  client = mqtt.connect(config.MQTT_URL, {
    username: config.MQTT_USERNAME,
    password: config.MQTT_PASSWORD,
    reconnectPeriod: 5000,
    connectTimeout: 15000,
    clientId: `announcer-${Math.random().toString(16).slice(2, 8)}`,
  });

  client.on('connect', () => {
    logger.info('mqtt connected');
    // Escuchar la telemetría de TODOS los speakers para auto-provisioning + online.
    client.subscribe(STATUS_TOPIC, { qos: 0 }, (err) => {
      if (err) logger.error({ err: err.message }, 'mqtt subscribe status failed');
      else logger.info({ topic: STATUS_TOPIC }, 'mqtt subscribed to speaker status');
    });
  });
  client.on('error', (err) => logger.error({ err: err.message }, 'mqtt error'));
  client.on('offline', () => logger.warn('mqtt offline'));
  client.on('reconnect', () => logger.info('mqtt reconnecting'));

  client.on('message', (topic, buf) => {
    const m = /^speakers\/([^/]+)\/status$/.exec(topic);
    if (!m || !onStatus) return;
    const spkrId = m[1];
    let info = {};
    try {
      const raw = JSON.parse(buf.toString());
      info = normalizeStatus(raw);
    } catch {
      return; // payload no-JSON: ignorar
    }
    try { onStatus(spkrId, info); }
    catch (e) { logger.warn({ err: e.message, spkrId }, 'onSpeakerStatus handler error'); }
  });

  return client;
}

/** Normaliza la respuesta getinfo del speaker a campos de device.
 *  El firmware reporta: sn, imei, imsi, iccid, volume, batt, signal, verno.
 *  OJO: `batt` viene en MILIVOLTIOS (ej 4030 = ~4.03V), NO en %. El PDF dice
 *  lleno >4100mV, se apaga <3400mV. Convertimos a % para mostrarlo. */
function normalizeStatus(raw) {
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const mac = raw.mac || raw.wsmac || raw.sn || null;
  const battToPct = (mv) => {
    const v = num(mv);
    if (v == null) return null;
    if (v <= 100) return Math.round(v);           // ya viene en % (algún firmware)
    const pct = ((v - 3400) / (4150 - 3400)) * 100; // mV → % (3400=0%, 4150=100%)
    return Math.max(0, Math.min(100, Math.round(pct)));
  };
  return {
    mac: mac ? String(mac).toUpperCase().replace(/[^0-9A-F]/g, '') || String(mac) : null,
    imei: raw.imei ? String(raw.imei) : null,
    iccid: raw.iccid ? String(raw.iccid) : null,
    signal: num(raw.signal ?? raw.csq),
    battery: battToPct(raw.batt ?? raw.battery),
    firmware: raw.verno || raw.firmware || null,
    ssid: raw.ssid ? String(raw.ssid) : null,   // WiFi: a qué red está conectado
    model: raw.imei ? '4g' : 'wifi',
  };
}

/** Espera (máx 10s) a que el cliente MQTT conecte. Limpia SIEMPRE sus listeners
 *  al resolver, rechazar o vencer el timeout: sin esto, con el broker caído cada
 *  publish acumulaba un once('connect')/once('error') huérfano en el cliente
 *  (warning MaxListeners) hasta que llegara un 'connect'. */
function waitForConnect(c) {
  return new Promise((res, rej) => {
    const cleanup = () => {
      clearTimeout(t);
      c.removeListener('connect', onConnect);
      c.removeListener('error', onError);
    };
    const onConnect = () => { cleanup(); res(); };
    const onError = (err) => { cleanup(); rej(err); };
    const t = setTimeout(() => { cleanup(); rej(new Error('mqtt connect timeout 10s')); }, 10_000);
    c.once('connect', onConnect);
    c.once('error', onError);
  });
}

/**
 * @param {string} playAudibleMsg
 * @param {Object} [opts]
 * @param {number} [opts.amount]
 * @param {string} [opts.speakerId]  - default config.SPEAKER_DEVICE_ID
 */
export async function publishVoice(playAudibleMsg, opts = {}) {
  // SEGURIDAD: si el pago no trae un speakerId resuelto (cuenta sin speaker asignado, o
  // multipunto sin match de llave), NO publicamos. Antes caía a config.SPEAKER_DEVICE_ID
  // (spkr-001 por default) → ¡los pagos de una cuenta sonaban en el speaker de OTRO cliente!
  const speakerId = opts.speakerId;
  if (!speakerId) {
    logger.warn({ amount: opts.amount }, 'publishVoice SIN speakerId → NO se publica (evita sonar en speaker ajeno)');
    return { skipped: true, reason: 'no-speaker' };
  }

  const c = connect();
  if (!c.connected) await waitForConnect(c);

  const payload = { cmd: 'voice', playAudibleMsg };
  if (opts.amount != null) payload.amount = String(opts.amount).slice(0, 8);

  const topic = `speakers/${speakerId}/cmd`;

  logger.info({ topic, payload }, 'mqtt publish voice');

  return new Promise((res, rej) => {
    c.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
      if (err) return rej(err);
      res();
    });
  });
}

/** Publica un comando arbitrario al speaker (ej. {cmd:'getinfo'}). */
export async function publishCommand(speakerId, payload) {
  const c = connect();
  if (!c.connected) await waitForConnect(c);
  const topic = `speakers/${speakerId}/cmd`;
  return new Promise((res, rej) => {
    c.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => err ? rej(err) : res());
  });
}

export function close() {
  if (client) {
    client.end();
    client = null;
  }
}
