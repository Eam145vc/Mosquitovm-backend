import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'waenv-')), 'db.sqlite');
process.env.ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.MQTT_URL = 'mqtt://d'; process.env.MQTT_USERNAME = 'd'; process.env.MQTT_PASSWORD = 'd';
const { openDb, createShipmentRow, getShipmentByOrder, updateShipmentRow } = await import('../src/storage.js');
openDb();

test('createShipmentRow guarda tracking_url', () => {
  createShipmentRow({ orderId: 'o1', skydropxId: 's1', tracking: 'T1', trackingUrl: 'http://track/T1' });
  const r = getShipmentByOrder('o1');
  assert.equal(r.tracking_url, 'http://track/T1');
});

test('updateShipmentRow acepta tracking_url', () => {
  createShipmentRow({ orderId: 'o2', skydropxId: 's2' });
  const r = getShipmentByOrder('o2');
  updateShipmentRow(r.id, { tracking: 'T2', tracking_url: 'http://track/T2', status: 'label_ready' });
  const r2 = getShipmentByOrder('o2');
  assert.equal(r2.tracking, 'T2');
  assert.equal(r2.tracking_url, 'http://track/T2');
});
