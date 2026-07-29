// MODO ECO: un pago suena en TODOS los speakers de la cuenta cuando comparten
// la misma llave Bre-B (2ª compra del mismo cliente, un local con varias
// bocinas). Cubre el ruteo de pickSpeaker vía webhook + el endpoint admin
// link-account (vincular una orden nueva a la cuenta existente).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'eco-')), 'db.sqlite');
process.env.EMAIL_WEBHOOK_SECRET = 'testsecret123';
process.env.ADMIN_TOKEN = 'admintest123';
process.env.HTTP_PORT = '0';

const s = await import('../src/storage.js');
const { startHttp } = await import('../src/http-server.js');
s.openDb();

// Spy de onPaymentDetected (en producción es announcePayment).
const pagosAnunciados = [];
const app = startHttp(() => {}, (p) => pagosAnunciados.push(p), () => {});
await app.ready();

const admin = (method, url, payload) => app.inject({
  method, url, payload,
  headers: { authorization: 'Bearer admintest123', 'content-type': 'application/json' },
});

let n = 0;
function mkCuenta(alias) {
  const id = `acc-eco-${++n}`;
  s.upsertAccount({ id, email: `eco${n}@gmail.com`, refreshToken: 'rt', authType: 'oauth' });
  if (alias) s.setAccountForward(id, { alias, forwardTo: `dueno${n}@gmail.com` });
  return id;
}
function mkOrden({ accountId = null } = {}) {
  const id = s.createOrder({ amountCents: 8_900_000 });
  const patch = { status: 'paid', business_name: 'Eco Test' };
  if (accountId) patch.account_id = accountId;
  s.updateOrder(id, patch);
  return id;
}
function mkDevice(spkrId, orderId, key, localName) {
  s.createDevice({ spkrId, mac: `EC:${spkrId}`, model: 'wifi' });
  s.assignDevice(spkrId, orderId);
  if (key) s.setDeviceBrebKey(spkrId, { key, localName });
}
const pagoBancolombia = (alias, llave) => app.inject({
  method: 'POST',
  url: '/webhook/email',
  headers: { 'x-sono-secret': 'testsecret123', 'content-type': 'application/json' },
  payload: {
    alias,
    from: 'alertasynotificaciones@notificacionesbancolombia.com',
    subject: 'Bancolombia te informa Recepcion transferencia',
    text: `Bancolombia: Recibiste una transferencia por $25.000 de JUAN PEREZ en tu cuenta *4369 conectado a la llave ${llave} el 03/07/2026.`,
    messageId: `<eco-${++n}@banco>`,
  },
});

test('storage: findDevicesByKey devuelve TODOS los devices con la llave', () => {
  const acc = mkCuenta();
  const o1 = mkOrden({ accountId: acc });
  const o2 = mkOrden({ accountId: acc });
  mkDevice('spkr-e01', o1, '@mismallave', 'Local');
  mkDevice('spkr-e02', o2, '@mismallave', 'Local');
  const devs = s.findDevicesByKey(acc, '@mismallave');
  assert.deepEqual(devs.map((d) => d.spkr_id), ['spkr-e01', 'spkr-e02']);
  // el singular sigue funcionando (primer match)
  assert.equal(s.findDeviceByKey(acc, '@mismallave').spkr_id, 'spkr-e01');
  assert.deepEqual(s.findDevicesByKey(acc, '@otra'), []);
});

test('eco: 2 devices misma llave → el pago CON llave suena en ambos', async () => {
  const acc = mkCuenta('ecoalias1');
  mkDevice('spkr-e11', mkOrden({ accountId: acc }), '@tiendauno', 'Tienda');
  mkDevice('spkr-e12', mkOrden({ accountId: acc }), '@tiendauno', 'Tienda');

  const antes = pagosAnunciados.length;
  const r = await pagoBancolombia('ecoalias1', '@tiendauno');
  assert.equal(r.statusCode, 200);
  assert.equal(pagosAnunciados.length, antes + 1, 'el pago se anuncia UNA vez (con N speakers)');
  const p = pagosAnunciados.at(-1);
  assert.deepEqual(p.speakerIds, ['spkr-e11', 'spkr-e12']);
  assert.equal(p.speakerId, 'spkr-e11');
});

test('eco: 2 devices misma llave → pago SIN llave (Nequi) también suena en ambos, NO unrouted', async () => {
  const acc = mkCuenta('ecoalias2');
  mkDevice('spkr-e21', mkOrden({ accountId: acc }), '@tiendados', 'Tienda');
  mkDevice('spkr-e22', mkOrden({ accountId: acc }), '@tiendados', 'Tienda');

  const antes = pagosAnunciados.length;
  const r = await app.inject({
    method: 'POST',
    url: '/webhook/email',
    headers: { 'x-sono-secret': 'testsecret123', 'content-type': 'application/json' },
    payload: {
      alias: 'ecoalias2',
      from: 'notificaciones@nequi.com.co',
      subject: 'Te enviaron plata',
      text: 'Te enviaron $10.000. Fecha: 03/07/2026 10:00:01. Referencia: 123',
      messageId: `<eco-nequi-${++n}@nequi>`,
    },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(pagosAnunciados.length, antes + 1, 'pago sin llave en cuenta eco DEBE sonar');
  const p = pagosAnunciados.at(-1);
  assert.deepEqual(p.speakerIds, ['spkr-e21', 'spkr-e22']);
  // hereda la llave del local (para La Libreta), como en mono-local
  assert.equal(p.brebKey, '@tiendados');
});

test('multipunto real (llaves distintas) NO cambia: pago con llave suena solo en su local', async () => {
  const acc = mkCuenta('ecoalias3');
  mkDevice('spkr-e31', mkOrden({ accountId: acc }), '@localnorte', 'Norte');
  mkDevice('spkr-e32', mkOrden({ accountId: acc }), '@localsur', 'Sur');

  const antes = pagosAnunciados.length;
  await pagoBancolombia('ecoalias3', '@localsur');
  assert.equal(pagosAnunciados.length, antes + 1);
  const p = pagosAnunciados.at(-1);
  assert.deepEqual(p.speakerIds, ['spkr-e32']);
  assert.equal(p.localName, 'Sur');
});

test('POST /admin/orders/:order/link-account vincula la orden nueva a la cuenta existente', async () => {
  const acc = mkCuenta('ecoalias4');
  mkDevice('spkr-e41', mkOrden({ accountId: acc }), '@ecolink', 'Tienda');
  // 2ª compra: orden pagada SIN cuenta (el cliente no repite onboarding)
  const o2 = mkOrden();
  mkDevice('spkr-e42', o2, '@ecolink', 'Tienda');

  // antes de vincular: la cuenta solo ve 1 device
  assert.equal(s.listDevicesByAccount(acc).length, 1);

  const r = await admin('POST', `/admin/orders/${o2}/link-account`, { account_id: acc });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.ok, true);
  assert.equal(body.echo, true, 'misma llave en ambos devices → modo eco');
  assert.deepEqual(body.devices.map((d) => d.spkr_id), ['spkr-e41', 'spkr-e42']);

  // y ahora el pago suena en ambos
  const antes = pagosAnunciados.length;
  await pagoBancolombia('ecoalias4', '@ecolink');
  assert.equal(pagosAnunciados.length, antes + 1);
  assert.deepEqual(pagosAnunciados.at(-1).speakerIds, ['spkr-e41', 'spkr-e42']);
});

test('link-account: por email, 404 si no existe, 409 si ya tiene otra cuenta (force la pisa)', async () => {
  const acc = mkCuenta();
  const otra = mkCuenta();
  const o = mkOrden({ accountId: otra });

  const r404 = await admin('POST', `/admin/orders/${o}/link-account`, { email: 'noexiste@x.com' });
  assert.equal(r404.statusCode, 404);

  const r409 = await admin('POST', `/admin/orders/${o}/link-account`, { account_id: acc });
  assert.equal(r409.statusCode, 409);

  const rForce = await admin('POST', `/admin/orders/${o}/link-account`, { account_id: acc, force: true });
  assert.equal(rForce.statusCode, 200);
  assert.equal(s.getOrder(o).account_id, acc);

  // por email de la cuenta también resuelve
  const o2 = mkOrden();
  const acc3 = mkCuenta();
  const rMail = await admin('POST', `/admin/orders/${o2}/link-account`, { email: `eco${n}@gmail.com` });
  assert.equal(rMail.statusCode, 200);
  assert.equal(rMail.json().account_id, acc3);
});

test('cierre', async () => { await app.close(); });
