import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'waenb-')), 'db.sqlite');
process.env.ENCRYPTION_KEY = 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.MQTT_URL = 'mqtt://d'; process.env.MQTT_USERNAME = 'd'; process.env.MQTT_PASSWORD = 'd';
const { openDb, createShipmentRow, listWaOutbox } = await import('../src/storage.js');
const { buildWaBody, enqueueEnvioIfReady } = await import('../src/wa-enqueue.js');
openDb();

test('buildWaBody envio con tracking_url => mensaje con link', () => {
  createShipmentRow({ orderId: 'E1', tracking: 'GUIA123', carrier: 'Envía', trackingUrl: 'http://t/GUIA123' });
  const body = buildWaBody({ id: 'E1', business_name: 'Tienda', phone: '3001112233' }, 'envio');
  assert.match(body, /GUIA123/);
  assert.match(body, /http:\/\/t\/GUIA123/);
});

test('buildWaBody envio sin tracking_url => número + carrier, sin link', () => {
  createShipmentRow({ orderId: 'E2', tracking: 'GUIA999', carrier: 'Interrapidísimo' });
  const body = buildWaBody({ id: 'E2', business_name: 'X', phone: '3001112233' }, 'envio');
  assert.match(body, /GUIA999/);
  assert.match(body, /Interrapidísimo/);
});

test('enqueueEnvioIfReady con tracking => encola; sin tracking => false', () => {
  createShipmentRow({ orderId: 'E3', tracking: 'G3', carrier: 'Envía' });
  assert.equal(enqueueEnvioIfReady({ id: 'E3', phone: '3001112233', business_name: 'X' }), true);
  createShipmentRow({ orderId: 'E4', carrier: 'Envía' }); // sin tracking
  assert.equal(enqueueEnvioIfReady({ id: 'E4', phone: '3001112233', business_name: 'X' }), false);
});

test('enqueueEnvioIfReady sin teléfono => false', () => {
  createShipmentRow({ orderId: 'E5', tracking: 'G5', carrier: 'Envía' });
  assert.equal(enqueueEnvioIfReady({ id: 'E5', phone: '', business_name: 'X' }), false);
});
