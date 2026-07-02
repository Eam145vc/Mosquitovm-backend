import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB temporal por corrida: se setea ANTES de importar storage/config.
process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY = 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'wa-dedupe-')), 'db.sqlite');

const { openDb, listWaOutbox } = await import('../src/storage.js');
const { enqueueWhatsApp, enqueueWhatsAppForce } = await import('../src/wa-enqueue.js');

openDb();

test('cliente con 2 órdenes: el mismo recordatorio NO se duplica al mismo teléfono', () => {
  const a = enqueueWhatsApp({ id: 'dupA', phone: '3226752920', business_name: 'Tienda' }, 'recordatorio_24h');
  // Mismo teléfono con otro formato: la normalización debe atraparlo igual.
  const b = enqueueWhatsApp({ id: 'dupB', phone: '57 322 675 2920', business_name: 'Tienda' }, 'recordatorio_24h');
  assert.equal(a, true);
  assert.equal(b, false, 'la segunda orden del mismo teléfono no debe encolar el mismo kind');
  const rows = listWaOutbox().filter((r) => r.kind === 'recordatorio_24h' && r.phone === '573226752920');
  assert.equal(rows.length, 1);
});

test('kinds distintos al mismo teléfono sí pasan', () => {
  const ok = enqueueWhatsApp({ id: 'dupB', phone: '3226752920' }, 'recordatorio_3h');
  assert.equal(ok, true);
});

test("'envio' no dedupea por teléfono (cada orden lleva su guía)", () => {
  const e1 = enqueueWhatsApp({ id: 'envA', phone: '3009998877' }, 'envio');
  const e2 = enqueueWhatsApp({ id: 'envB', phone: '3009998877' }, 'envio');
  assert.equal(e1, true);
  assert.equal(e2, true);
});

test('el reenvío manual (force) ignora el dedupe por teléfono', () => {
  const ok = enqueueWhatsAppForce({ id: 'dupB', phone: '3226752920' }, 'recordatorio_24h');
  assert.equal(ok, true);
});
