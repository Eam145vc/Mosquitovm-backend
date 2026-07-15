import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.DB_PATH = './_data/test-meta-capi.sqlite';
process.env.META_CAPI_TOKEN = 'test-token';

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync('./_data/test-meta-capi.sqlite' + ext, { force: true }); } catch {}
}

const s = await import('../src/storage.js');
const { isConverted, reportPurchasesToMeta } = await import('../src/meta-capi.js');

before(() => s.openDb());

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetchOk(calls) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ events_received: 1 }) };
  };
}

describe('isConverted (misma regla que el front)', () => {
  test('online paga cuenta; online sin pagar no', () => {
    assert.equal(isConverted({ status: 'pendiente_qr', delivery: 'online' }), true);
    assert.equal(isConverted({ status: 'created', delivery: 'online' }), false);
  });

  test('COD solo cuenta con QR subido', () => {
    const base = { status: 'cod_pending', delivery: 'contraentrega' };
    assert.equal(isConverted(base), false);
    assert.equal(isConverted({ ...base, qr_path: '/x/qr.png' }), true);
  });

  test('archivada nunca cuenta', () => {
    assert.equal(isConverted({ status: 'paid', delivery: 'online', archived_at: 1 }), false);
  });
});

describe('reportPurchasesToMeta', () => {
  test('reporta la orden convertida con event_id = orderId y la marca (idempotente)', async () => {
    const id = s.createOrder({ amountCents: 29900000 });
    s.updateOrder(id, {
      status: 'pendiente_qr', customer_email: 'Cliente@Test.com ', phone: '300 123 4567',
    });

    const calls = [];
    mockFetchOk(calls);

    assert.equal(await reportPurchasesToMeta(), 1);
    assert.equal(calls.length, 1);
    const ev = calls[0].body.data[0];
    assert.equal(ev.event_name, 'Purchase');
    assert.equal(ev.event_id, id);
    assert.equal(ev.action_source, 'website');
    assert.equal(ev.custom_data.value, 299000);
    assert.equal(ev.custom_data.currency, 'COP');
    // email lowercased+trim y phone 57XXXXXXXXXX, ambos hasheados (64 hex)
    assert.match(ev.user_data.em[0], /^[0-9a-f]{64}$/);
    assert.match(ev.user_data.ph[0], /^[0-9a-f]{64}$/);

    // segunda pasada: ya está marcada, no se reenvía
    assert.equal(await reportPurchasesToMeta(), 0);
    assert.equal(calls.length, 1);
    assert.ok(s.getOrder(id).meta_capi_at > 0);
  });

  test('si Graph API falla NO se marca (reintenta al siguiente ciclo)', async () => {
    const id = s.createOrder({ amountCents: 1000000 });
    s.updateOrder(id, { status: 'paid', phone: '3001112233' });

    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) });
    assert.equal(await reportPurchasesToMeta(), 0);
    assert.equal(s.getOrder(id).meta_capi_at, null);

    const calls = [];
    mockFetchOk(calls);
    assert.equal(await reportPurchasesToMeta(), 1);
    assert.ok(s.getOrder(id).meta_capi_at > 0);
  });

  test('COD sin QR no se reporta; al subir el QR sí', async () => {
    const id = s.createOrder({ amountCents: 2000000 });
    s.updateOrder(id, { status: 'cod_pending', delivery: 'contraentrega', phone: '3009998877' });

    const calls = [];
    mockFetchOk(calls);
    assert.equal(await reportPurchasesToMeta(), 0);

    s.updateOrder(id, { qr_path: '/qr/x.png' });
    assert.equal(await reportPurchasesToMeta(), 1);
    assert.equal(calls[0].body.data[0].event_id, id);
  });
});
