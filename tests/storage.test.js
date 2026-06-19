import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY ||= 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.DB_PATH = './_data/test-storage.sqlite';

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync('./_data/test-storage.sqlite' + ext, { force: true }); } catch {}
}

const s = await import('../src/storage.js');

before(() => s.openDb());

describe('orders', () => {
  test('createOrder genera token y deja status created', () => {
    const id = s.createOrder({ amountCents: 18900000 });
    assert.equal(id.length, 32);
    const o = s.getOrder(id);
    assert.equal(o.status, 'created');
    assert.equal(o.amount_cents, 18900000);
    assert.equal(o.wompi_reference, id); // reference por defecto = id
  });

  test('updateOrder solo aplica campos permitidos', () => {
    const id = s.createOrder({ amountCents: 1000 });
    s.updateOrder(id, { status: 'pendiente_qr', business_name: 'Tienda Ana', hacker: 'x' });
    const o = s.getOrder(id);
    assert.equal(o.status, 'pendiente_qr');
    assert.equal(o.business_name, 'Tienda Ana');
    assert.equal(o.hacker, undefined);
  });

  test('getOrderByReference encuentra por referencia', () => {
    const id = s.createOrder({ amountCents: 500 });
    assert.equal(s.getOrderByReference(id).id, id);
  });
});

describe('accounts oauth + imap', () => {
  test('oauth: cifra y recupera refreshToken', () => {
    s.upsertAccount({ id: 'a-oauth', email: 'ana@gmail.com', refreshToken: 'rt-secreto', authType: 'oauth' });
    const a = s.getAccount('a-oauth');
    assert.equal(a.auth_type, 'oauth');
    assert.equal(a.refreshToken, 'rt-secreto');
  });

  test('imap: cifra y recupera password + host/port', () => {
    s.upsertAccount({
      id: 'a-imap', email: 'b@corp.com', authType: 'imap',
      imapHost: 'imap.corp.com', imapPort: 993, imapUser: 'b@corp.com', imapPass: 'clave-app',
    });
    const a = s.getAccount('a-imap');
    assert.equal(a.auth_type, 'imap');
    assert.equal(a.imap_host, 'imap.corp.com');
    assert.equal(a.imapPass, 'clave-app');
  });

  test('setAccountSpeaker asigna el speaker', () => {
    s.setAccountSpeaker('a-oauth', 'spkr-007');
    assert.equal(s.getAccount('a-oauth').speaker_id, 'spkr-007');
  });

  test('getAccountByEmail no duplica cuenta por correo', () => {
    assert.equal(s.getAccountByEmail('ana@gmail.com').id, 'a-oauth');
  });
});

describe('devices (inventario)', () => {
  test('createDevice queda provisionado', () => {
    const d = s.createDevice({ spkrId: 'spkr-007', mac: 'AA:BB:CC', model: 'wifi', label: '#7' });
    assert.equal(d.status, 'provisionado');
    assert.equal(d.mac, 'AA:BB:CC');
  });

  test('assignDevice vincula a la orden y marca asignado', () => {
    const order = s.createOrder({ amountCents: 1000 });
    s.assignDevice('spkr-007', order);
    const d = s.getDevice('spkr-007');
    assert.equal(d.status, 'asignado');
    assert.equal(d.order_id, order);
  });
});
