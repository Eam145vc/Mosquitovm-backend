import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'wasop-')), 'db.sqlite');
process.env.ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.MQTT_URL = 'mqtt://d'; process.env.MQTT_USERNAME = 'd'; process.env.MQTT_PASSWORD = 'd';

const {
  openDb, insertWaInbound, listWaChats, listWaChatMessages, markWaChatRead,
  countWaChatUnread, updateWaDeliveryByWamid,
} = await import('../src/storage.js');
openDb();

test('hilo de chat: agrupa por teléfono con no-leídos y último mensaje', () => {
  insertWaInbound({ id: 'wm1', phone: '573001112233', name: 'Carlos', type: 'text', body: 'hola necesito ayuda' });
  insertWaInbound({ id: 'wm2', phone: '573001112233', name: 'Carlos', type: 'text', body: 'sigo esperando' });
  insertWaInbound({ id: 'wm3', phone: '573001112233', type: 'text', body: 'ya te ayudo', direction: 'out' });
  insertWaInbound({ id: 'wm4', phone: '573009998877', type: 'text', body: 'otro cliente' });

  const chats = listWaChats();
  assert.equal(chats.length, 2);
  const c = chats.find((x) => x.phone === '573001112233');
  assert.equal(c.unread, 2);            // solo los entrantes cuentan
  assert.equal(c.last_body, 'ya te ayudo');
  assert.equal(c.last_direction, 'out');
  assert.equal(c.name, 'Carlos');       // toma el último name conocido
});

test('mensajes del hilo en orden ascendente e idempotencia por wamid', () => {
  assert.equal(insertWaInbound({ id: 'wm1', phone: '573001112233', type: 'text', body: 'duplicado' }), false);
  const msgs = listWaChatMessages('573001112233');
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].body, 'hola necesito ayuda');
  assert.equal(msgs.at(-1).direction, 'out');
});

test('abrir el hilo marca leídos; el otro chat no se toca', () => {
  assert.equal(countWaChatUnread(), 3);
  assert.equal(markWaChatRead('573001112233'), 2);
  assert.equal(countWaChatUnread(), 1);
});

test('statuses de Meta actualizan el saliente del hilo (chulitos)', () => {
  updateWaDeliveryByWamid('wm3', 'delivered');
  let out = listWaChatMessages('573001112233').at(-1);
  assert.equal(out.delivery, 'delivered');
  updateWaDeliveryByWamid('wm3', 'sent'); // llega tarde: NO degrada
  out = listWaChatMessages('573001112233').at(-1);
  assert.equal(out.delivery, 'delivered');
  updateWaDeliveryByWamid('wm3', 'read');
  out = listWaChatMessages('573001112233').at(-1);
  assert.equal(out.delivery, 'read');
});
