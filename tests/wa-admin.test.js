import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB temporal + config dummy: se setea ANTES de importar storage/config.
process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY = 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'waadm-')), 'db.sqlite');

const { openDb, enqueueWa, claimWaPending, markWaSent, requeueWa, cancelWa, listWaOutbox } =
  await import('../src/storage.js');
openDb();

test('cancelWa: queued -> canceled; no toca sent', () => {
  enqueueWa({ orderId: 'cx1', phone: '573001112233', kind: 'activacion', body: 'x' });
  const row = listWaOutbox().find((r) => r.order_id === 'cx1');
  assert.equal(cancelWa(row.id), true);
  assert.equal(listWaOutbox().find((r) => r.order_id === 'cx1').status, 'canceled');
  // ya cancelado, cancelar de nuevo => false
  assert.equal(cancelWa(row.id), false);
});

test('requeueWa: failed -> queued', () => {
  enqueueWa({ orderId: 'rq1', phone: '573001112233', kind: 'activacion', body: 'x' });
  const claimed = claimWaPending(50).find((r) => r.order_id === 'rq1');
  markWaSent(claimed.id, false, 'boom');
  assert.equal(listWaOutbox().find((r) => r.order_id === 'rq1').status, 'failed');
  assert.equal(requeueWa(claimed.id), true);
  assert.equal(listWaOutbox().find((r) => r.order_id === 'rq1').status, 'queued');
});

test('requeueWa: no toca una fila queued (no estaba failed/canceled)', () => {
  enqueueWa({ orderId: 'rq2', phone: '573001112233', kind: 'activacion', body: 'x' });
  const row = listWaOutbox().find((r) => r.order_id === 'rq2');
  assert.equal(requeueWa(row.id), false);
});
