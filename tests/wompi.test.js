import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Env completa ANTES de importar config (que se parsea una sola vez).
process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY ||= 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.DB_PATH ||= './_data/test.sqlite';
process.env.WOMPI_PUBLIC_KEY ||= 'pub_test_abc';
process.env.WOMPI_INTEGRITY_SECRET ||= 'integ_secret';
process.env.WOMPI_EVENTS_SECRET ||= 'events_secret';
process.env.FRONTEND_BASE_URL ||= 'http://localhost:3001';

const { integritySignature, buildCheckout, verifyEvent, getEventTransaction } =
  await import('../src/wompi.js');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

describe('wompi integrity signature', () => {
  test('SHA256(reference+amount+currency+secret)', () => {
    const sig = integritySignature({ reference: 'ref1', amountCents: 1000, currency: 'COP' });
    assert.equal(sig, sha256('ref1' + 1000 + 'COP' + 'integ_secret'));
  });
});

describe('wompi buildCheckout', () => {
  test('arma URL con colon literal y redirect al wizard', () => {
    const { checkoutUrl } = buildCheckout({ reference: 'ord-9', amountCents: 18900000 });
    assert.match(checkoutUrl, /^https:\/\/checkout\.wompi\.co\/p\/\?/);
    assert.ok(checkoutUrl.includes('signature:integrity='), 'colon literal preservado');
    assert.ok(checkoutUrl.includes('amount-in-cents=18900000'));
    assert.ok(checkoutUrl.includes(encodeURIComponent('http://localhost:3001/activar?order=ord-9')));
  });
});

describe('wompi verifyEvent', () => {
  function signedBody(status = 'APPROVED') {
    const body = {
      data: { transaction: { id: 'txn1', status, amount_in_cents: 1000, reference: 'ref1' } },
      timestamp: 123,
      signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum: '' },
    };
    const concat = 'txn1' + status + '1000';
    body.signature.checksum = sha256(concat + '123' + 'events_secret');
    return body;
  }

  test('acepta checksum válido', () => {
    assert.equal(verifyEvent(signedBody()), true);
  });

  test('rechaza checksum inválido', () => {
    const body = signedBody();
    body.signature.checksum = 'deadbeef';
    assert.equal(verifyEvent(body), false);
  });

  test('rechaza si faltan properties', () => {
    assert.equal(verifyEvent({ signature: {} }), false);
  });

  test('getEventTransaction extrae la transacción', () => {
    assert.equal(getEventTransaction(signedBody()).id, 'txn1');
  });
});
