import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB temporal + config dummy: se setea ANTES de importar storage/config/http-server
// (patrón libreta-endpoint.test.js).
process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'corracc-')), 'db.sqlite');
process.env.EMAIL_WEBHOOK_SECRET = 'testsecret123';
process.env.HTTP_PORT = '0';

const s = await import('../src/storage.js');
const { startHttp } = await import('../src/http-server.js');
s.openDb();

const app = startHttp(() => {}, () => {}, () => {});
await app.ready();

const post = (phone) => app.inject({
  method: 'POST', url: '/correo-acceso',
  headers: { 'content-type': 'application/json' },
  payload: { phone },
});

let nAcc = 0;
function mkCuenta() {
  const id = `acc-corr-${++nAcc}`;
  s.upsertAccount({ id, email: `privado${nAcc}@gmail.com`, refreshToken: 'rt', authType: 'oauth' });
  return id;
}
function mkOrden({ phone, status = 'paid', accountId = null, businessName = 'Tienda Test' } = {}) {
  const id = s.createOrder({ amountCents: 8_900_000 });
  const patch = { status, business_name: businessName, phone };
  if (accountId) patch.account_id = accountId;
  s.updateOrder(id, patch);
  return id;
}

test('teléfono sin orden → found:false (sin enlace)', async () => {
  const r = await post('300 111 2233');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, found: false });
});

test('body sin teléfono → found:false, nunca 500', async () => {
  const r = await app.inject({ method: 'POST', url: '/correo-acceso',
    headers: { 'content-type': 'application/json' }, payload: {} });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, found: false });
});

test('orden pagada sin cuenta → connected:false + connectUrl del wizard &correo=1', async () => {
  const oid = mkOrden({ phone: '3009998877', businessName: 'Panadería Uno' });
  const r = await post('300 999 8877'); // con espacios: normalizePhoneCO los limpia
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.found, true);
  assert.equal(body.connected, false);
  assert.equal(body.businessName, 'Panadería Uno');
  assert.ok(body.connectUrl.endsWith(`/activar-pro/?order=${oid}&correo=1`), body.connectUrl);
});

test('orden contraentrega (cod_pending) también recibe su enlace', async () => {
  const oid = mkOrden({ phone: '3012223344', status: 'cod_pending' });
  const r = await post('3012223344');
  const body = r.json();
  assert.equal(body.found, true);
  assert.equal(body.connected, false);
  assert.ok(body.connectUrl.includes(oid));
});

test('correo ya conectado → connected:true y SIN connectUrl en el body', async () => {
  const acc = mkCuenta();
  mkOrden({ phone: '3023334455', accountId: acc, businessName: 'Ya Conectada SAS' });
  const r = await post('3023334455');
  const body = r.json();
  assert.equal(body.found, true);
  assert.equal(body.connected, true);
  assert.equal(body.businessName, 'Ya Conectada SAS');
  assert.ok(!('connectUrl' in body), 'conectado NO debe traer connectUrl');
  assert.ok(!r.body.includes('activar-pro'), 'ni rastro del enlace en el body');
});

test('órdenes duplicadas: si CUALQUIERA tiene cuenta → connected:true (onboarding por cliente)', async () => {
  const acc = mkCuenta();
  mkOrden({ phone: '3034445566', accountId: acc });   // la orden real, conectada
  mkOrden({ phone: '3034445566' });                    // gemela posterior sin cuenta
  const r = await post('3034445566');
  const body = r.json();
  assert.equal(body.connected, true, 'no debe mandar a "conectar" la orden gemela');
  assert.ok(!('connectUrl' in body));
});

test('orden archivada o sin pagar → found:false (kill-switch)', async () => {
  const archivada = mkOrden({ phone: '3045556677' });
  s.updateOrder(archivada, { archived_at: Date.now() });
  mkOrden({ phone: '3056667788', status: 'created' }); // checkout abandonado
  for (const ph of ['3045556677', '3056667788']) {
    const r = await post(ph);
    assert.deepEqual(r.json(), { ok: true, found: false }, `phone ${ph}`);
  }
});

test('rate limit por teléfono: tras 10 consultas, la 11ª da 429', async () => {
  mkOrden({ phone: '3067778899' });
  let last;
  for (let i = 0; i < 11; i++) last = await post('3067778899');
  assert.equal(last.statusCode, 429);
});
