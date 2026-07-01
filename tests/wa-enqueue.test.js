import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'waenq-')), 'db.sqlite');
process.env.ENCRYPTION_KEY = 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.MQTT_URL = 'mqtt://d'; process.env.MQTT_USERNAME = 'd'; process.env.MQTT_PASSWORD = 'd';

const { openDb, listWaOutbox } = await import('../src/storage.js');
const { normalizePhoneCO, buildWaBody, enqueueWhatsApp } = await import('../src/wa-enqueue.js');
openDb();

test('normalizePhoneCO: celular de 10 dígitos con 3 => 57 + número', () => {
  assert.equal(normalizePhoneCO('3001112233'), '573001112233');
  assert.equal(normalizePhoneCO('300 111 2233'), '573001112233');
  assert.equal(normalizePhoneCO('(300) 111-2233'), '573001112233');
});

test('normalizePhoneCO: ya viene con 57 o +57 => se respeta', () => {
  assert.equal(normalizePhoneCO('+57 300 111 2233'), '573001112233');
  assert.equal(normalizePhoneCO('573001112233'), '573001112233');
});

test('normalizePhoneCO: número raro => se limpia pero se devuelve (política siempre-intentar)', () => {
  assert.equal(normalizePhoneCO('601 5551234'), '6015551234'); // fijo Bogotá, no se descarta
  assert.equal(normalizePhoneCO('abc'), ''); // sin dígitos => vacío
});

test('buildWaBody incluye el link con el order id y es no vacío', () => {
  const body = buildWaBody({ id: 'ORD123', business_name: 'Tienda Ana' }, 'activacion');
  assert.match(body, /activar-pro\?order=ORD123/);
  assert.ok(body.length > 20);
});

test('buildWaBody es determinista por order.id (misma variante siempre)', () => {
  const a = buildWaBody({ id: 'SAME', business_name: 'X' }, 'recordatorio_3h');
  const b = buildWaBody({ id: 'SAME', business_name: 'X' }, 'recordatorio_3h');
  assert.equal(a, b);
});

test('enqueueWhatsApp sin teléfono => false, no encola', () => {
  const ok = enqueueWhatsApp({ id: 'NOPHONE', phone: '', business_name: 'X' }, 'activacion');
  assert.equal(ok, false);
  assert.equal(listWaOutbox().some((r) => r.order_id === 'NOPHONE'), false);
});

test('enqueueWhatsApp con teléfono => encola normalizado', () => {
  const ok = enqueueWhatsApp({ id: 'ORD9', phone: '300 111 2233', business_name: 'X' }, 'activacion');
  assert.equal(ok, true);
  const row = listWaOutbox().find((r) => r.order_id === 'ORD9');
  assert.equal(row.phone, '573001112233');
  assert.equal(row.kind, 'activacion');
});
