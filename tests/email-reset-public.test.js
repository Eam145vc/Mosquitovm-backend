import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'emreset-')), 'db.sqlite');
process.env.EMAIL_WEBHOOK_SECRET = 'testsecret123';
process.env.HTTP_PORT = '0';

const s = await import('../src/storage.js');
const { startHttp } = await import('../src/http-server.js');
s.openDb();

const app = startHttp(() => {}, () => {}, () => {});
await app.ready();

const get = (url) => app.inject({ method: 'GET', url });
const reset = (order) => app.inject({ method: 'POST', url: `/activar/${order}/email-reset` });

let n = 0;
/** Deja una orden pagada YA "conectada": cuenta + change_confirmed (el estado falso
 *  que el cliente marca en su apuro). Devuelve { oid, accId }. */
function mkConectada() {
  const oid = s.createOrder({ amountCents: 8_900_000 });
  const accId = `acc-reset-${++n}`;
  s.upsertAccount({ id: accId, email: `zz${n}@sono.lat`, refreshToken: 'rt', authType: 'imap', provider: 'redirect' });
  s.setAccountForward(accId, { alias: `zz${n}`, forwardTo: `cliente${n}@gmail.com` });
  s.updateOrder(oid, { status: 'paid', business_name: 'Tienda', account_id: accId, qr_path: 'qr.png' });
  s.markChangeConfirmed(accId);
  return { oid, accId };
}

test('reset desliga la cuenta: emailConnected/hasEmail pasan a false y el step baja', async () => {
  const { oid } = mkConectada();

  const antes = (await get(`/activar/${oid}`)).json();
  assert.equal(antes.emailConnected, true, 'precondición: aparece conectado');
  assert.equal(antes.hasEmail, true, 'precondición: correo listo (change_confirmed)');
  assert.equal(antes.step, 3, 'precondición: QR + correo → paso 3 (listo)');

  const r = await reset(oid);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, hadAccount: true });

  const despues = (await get(`/activar/${oid}`)).json();
  assert.equal(despues.emailConnected, false, 'la orden quedó sin cuenta');
  assert.equal(despues.hasEmail, false, 'ya no cuenta como correo listo');
  assert.equal(despues.step, 2, 'baja al paso de conectar el correo (QR sigue puesto)');
});

test('no destruye el alias: la cuenta y su alias siguen existiendo para reencontrarse', async () => {
  const { oid, accId } = mkConectada();
  await reset(oid);
  const acc = s.getAccount(accId);
  assert.ok(acc, 'la cuenta NO se borra');
  assert.equal(acc.alias, s.getAccount(accId).alias, 'el alias se conserva (inmutable por orden)');
  assert.ok(!acc.change_confirmed, 'pero la confirmación quedó limpia');
});

test('orden inexistente → 404; orden sin pagar → 402', async () => {
  const r404 = await reset('a'.repeat(32));
  assert.equal(r404.statusCode, 404);
  const noPagada = s.createOrder({ amountCents: 1000 }); // status 'created'
  const r402 = await reset(noPagada);
  assert.equal(r402.statusCode, 402);
});

test('idempotente: resetear una orden ya sin cuenta responde ok con hadAccount:false', async () => {
  const oid = s.createOrder({ amountCents: 8_900_000 });
  s.updateOrder(oid, { status: 'paid' });
  const r = await reset(oid);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, hadAccount: false });
});

test('rate limit: tras 10 resets de la misma orden, el 11º da 429', async () => {
  const { oid } = mkConectada();
  let last;
  for (let i = 0; i < 11; i++) last = await reset(oid);
  assert.equal(last.statusCode, 429);
});
