import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB temporal + config dummy: se setea ANTES de importar storage/config/http-server.
process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY = 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'waep-')), 'db.sqlite');
process.env.EMAIL_WEBHOOK_SECRET = 'testsecret123';
process.env.HTTP_PORT = '0'; // efímero (config.js lee HTTP_PORT, no PORT)

const { openDb, enqueueWa, listWaOutbox } = await import('../src/storage.js');
const { startHttp } = await import('../src/http-server.js');
openDb();

// startHttp arranca el server (app.listen) y retorna la instancia Fastify.
const app = startHttp(() => {}, () => {}, () => {});
// app.listen() es async; esperamos a que el server esté escuchando de verdad.
await new Promise((resolve) => setTimeout(resolve, 300));
const base = `http://127.0.0.1:${app.server.address().port}`;
const H = { 'Content-Type': 'application/json', 'x-sono-secret': 'testsecret123' };

test('GET /wa/pending sin secret => 401', async () => {
  const r = await fetch(`${base}/wa/pending`);
  assert.equal(r.status, 401);
});

test('GET /wa/pending con secret => devuelve queued y los marca sending', async () => {
  enqueueWa({ orderId: 'ep1', phone: '573001112233', kind: 'activacion', body: 'hola' });
  const r = await fetch(`${base}/wa/pending?limit=10`, { headers: H });
  assert.equal(r.status, 200);
  const data = await r.json();
  const mine = data.messages.find((m) => m.body === 'hola');
  assert.ok(mine);
  assert.ok(mine.id && mine.phone);
  const row = listWaOutbox().find((x) => x.order_id === 'ep1');
  assert.equal(row.status, 'sending');
});

test('POST /wa/sent ok => marca sent', async () => {
  enqueueWa({ orderId: 'ep2', phone: '573001112233', kind: 'activacion', body: 'y' });
  const pend = await (await fetch(`${base}/wa/pending?limit=50`, { headers: H })).json();
  const msg = pend.messages.find((m) => m.body === 'y');
  const r = await fetch(`${base}/wa/sent`, { method: 'POST', headers: H, body: JSON.stringify({ id: msg.id, ok: true }) });
  assert.equal(r.status, 200);
  const row = listWaOutbox().find((x) => x.order_id === 'ep2');
  assert.equal(row.status, 'sent');
});

test('POST /wa/sent sin id => 400', async () => {
  const r = await fetch(`${base}/wa/sent`, { method: 'POST', headers: H, body: JSON.stringify({ ok: true }) });
  assert.equal(r.status, 400);
});

test.after(() => app.close());
