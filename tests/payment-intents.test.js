// Tests del checkout Bre-B propio: intents de pago con match por monto.
// Ventana de 2 min + gracia; FIFO cuando dos intents esperan el mismo monto.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.DB_PATH = './_data/test-intents.sqlite';

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync('./_data/test-intents.sqlite' + ext, { force: true }); } catch {}
}

const s = await import('../src/storage.js');

const TTL = 2 * 60 * 1000;

before(() => s.openDb());

describe('payment intents (checkout Bre-B propio)', () => {
  test('crea un intent pendiente con la ventana de 2 min', () => {
    const orderId = s.createOrder({ amountCents: 29900000 }); // $299.000
    const it = s.createPaymentIntent({ orderId, amount: 299000, ttlMs: TTL });
    assert.equal(it.status, 'pending');
    assert.equal(it.amount, 299000);
    assert.ok(it.expires_at - it.created_at === TTL);
    assert.equal(s.getPaymentIntent(it.id).order_id, orderId);
  });

  test('es idempotente: la misma orden reusa el intent vigente (no reinicia ventana)', () => {
    const orderId = s.createOrder({ amountCents: 8900000 });
    const a = s.createPaymentIntent({ orderId, amount: 89000, ttlMs: TTL });
    const b = s.createPaymentIntent({ orderId, amount: 89000, ttlMs: TTL });
    assert.equal(a.id, b.id);
    assert.equal(a.expires_at, b.expires_at);
  });

  test('matchea por monto exacto y marca paid', () => {
    const orderId = s.createOrder({ amountCents: 12345600 });
    const it = s.createPaymentIntent({ orderId, amount: 123456, ttlMs: TTL });
    assert.equal(s.matchPaymentIntent(999999), null); // otro monto no matchea
    const hit = s.matchPaymentIntent(123456, { bank: 'nequi' });
    assert.equal(hit.id, it.id);
    assert.equal(hit.status, 'paid');
    assert.equal(hit.bank, 'nequi');
    assert.equal(s.getPaymentIntent(it.id).status, 'paid');
    // ya pagado: un segundo pago igual no lo vuelve a matchear
    assert.equal(s.matchPaymentIntent(123456), null);
  });

  test('FIFO: con dos intents del mismo monto gana el más viejo', () => {
    const o1 = s.createOrder({ amountCents: 5000000 });
    const o2 = s.createOrder({ amountCents: 5000000 });
    const a = s.createPaymentIntent({ orderId: o1, amount: 50000, ttlMs: TTL });
    // separar created_at (better-sqlite3 es sync, mismo ms posible)
    const now = Date.now();
    s.openDb().prepare('UPDATE payment_intents SET created_at = ? WHERE id = ?').run(now - 1000, a.id);
    const b = s.createPaymentIntent({ orderId: o2, amount: 50000, ttlMs: TTL });
    const first = s.matchPaymentIntent(50000);
    assert.equal(first.id, a.id);
    const second = s.matchPaymentIntent(50000);
    assert.equal(second.id, b.id);
  });

  test('expirado fuera de la gracia NO matchea; dentro de la gracia SÍ', () => {
    const orderId = s.createOrder({ amountCents: 7700000 });
    const it = s.createPaymentIntent({ orderId, amount: 77000, ttlMs: TTL });
    const db = s.openDb();
    // venció hace 30s → dentro de la gracia de 45s → matchea
    db.prepare('UPDATE payment_intents SET expires_at = ? WHERE id = ?').run(Date.now() - 30_000, it.id);
    const hit = s.matchPaymentIntent(77000);
    assert.equal(hit.id, it.id);

    const orderId2 = s.createOrder({ amountCents: 7700000 });
    const it2 = s.createPaymentIntent({ orderId: orderId2, amount: 77000, ttlMs: TTL });
    // venció hace 2 min → fuera de la gracia → no matchea
    db.prepare('UPDATE payment_intents SET expires_at = ? WHERE id = ?').run(Date.now() - 120_000, it2.id);
    assert.equal(s.matchPaymentIntent(77000), null);
  });

  test('un intent vencido no se reusa: la orden genera uno nuevo', () => {
    const orderId = s.createOrder({ amountCents: 3300000 });
    const a = s.createPaymentIntent({ orderId, amount: 33000, ttlMs: TTL });
    s.openDb().prepare('UPDATE payment_intents SET expires_at = ? WHERE id = ?').run(Date.now() - 1, a.id);
    const b = s.createPaymentIntent({ orderId, amount: 33000, ttlMs: TTL });
    assert.notEqual(a.id, b.id);
    assert.equal(b.status, 'pending');
  });
});
