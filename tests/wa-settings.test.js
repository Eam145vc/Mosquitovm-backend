import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'waset-')), 'db.sqlite');
process.env.ENCRYPTION_KEY = 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.MQTT_URL = 'mqtt://localhost:1883';
process.env.MQTT_USERNAME = 'test';
process.env.MQTT_PASSWORD = 'test';

const { openDb, getWaSettings, setWaSettings, touchWaAgent, getWaAgentLastSeen, countWaByStatus, enqueueWa } =
  await import('../src/storage.js');
openDb();

test('getWaSettings devuelve defaults sin fila previa', () => {
  const s = getWaSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.active_hour_start, 8);
  assert.equal(s.active_hour_end, 21);
  assert.equal(s.daily_cap, 200);
  assert.equal(s.min_delay_ms, 8000);
  assert.equal(s.max_delay_ms, 20000);
});

test('setWaSettings hace merge parcial y persiste', () => {
  const s = setWaSettings({ enabled: false, daily_cap: 50 });
  assert.equal(s.enabled, false);
  assert.equal(s.daily_cap, 50);
  assert.equal(s.active_hour_start, 8); // no tocado
  const again = getWaSettings();
  assert.equal(again.enabled, false);
  assert.equal(again.daily_cap, 50);
});

test('touchWaAgent registra last_seen creciente', () => {
  assert.equal(getWaAgentLastSeen(), null);
  touchWaAgent();
  const t = getWaAgentLastSeen();
  assert.ok(t > 0);
});

test('countWaByStatus cuenta por estado', () => {
  enqueueWa({ orderId: 'cnt1', phone: '573001112233', kind: 'activacion', body: 'x' });
  const c = countWaByStatus();
  assert.ok(c.queued >= 1);
  assert.equal(typeof c.failed, 'number');
});
