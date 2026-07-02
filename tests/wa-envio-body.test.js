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

test('envio contraentrega sin pagar => incluye el valor a pagar discriminado', () => {
  createShipmentRow({ orderId: 'E6', tracking: 'G6', carrier: 'Envía' });
  const body = buildWaBody(
    { id: 'E6', business_name: 'X', phone: '3001112233', delivery: 'contraentrega', amount_cents: 20_400_000 },
    'envio',
  );
  assert.match(body, /Pagas al recibir: \$204\.000/);
  assert.match(body, /Producto: \$199\.000/);
  assert.match(body, /Recargo contraentrega: \$5\.000/);
});

test('envio contraentrega en cuotas => desglosa "1ª cuota + envío" (no "Producto")', () => {
  createShipmentRow({ orderId: 'E9', tracking: 'G9', carrier: 'Envía' });
  const body = buildWaBody(
    { id: 'E9', business_name: 'X', phone: '3001112233', delivery: 'contraentrega', plan: 'cuotas', amount_cents: 8_600_000 },
    'envio',
  );
  assert.match(body, /Pagas al recibir: \$86\.000/);
  assert.match(body, /1ª cuota \+ envío: \$81\.000/);
  assert.doesNotMatch(body, /Producto:/);
});

test('envio contraentrega YA cobrada online (wompi_txn_id) => NO pide plata', () => {
  createShipmentRow({ orderId: 'E7', tracking: 'G7', carrier: 'Envía' });
  const body = buildWaBody(
    { id: 'E7', business_name: 'X', phone: '3001112233', delivery: 'contraentrega', amount_cents: 20_400_000, wompi_txn_id: 'efi-123' },
    'envio',
  );
  assert.doesNotMatch(body, /Pagas al recibir/);
});

test('envio online => NO incluye bloque de pago', () => {
  createShipmentRow({ orderId: 'E8', tracking: 'G8', carrier: 'Envía' });
  const body = buildWaBody(
    { id: 'E8', business_name: 'X', phone: '3001112233', delivery: 'online', amount_cents: 19_900_000, wompi_txn_id: 'efi-9' },
    'envio',
  );
  assert.doesNotMatch(body, /Pagas al recibir/);
});
