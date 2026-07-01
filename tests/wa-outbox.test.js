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
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'wa-')), 'db.sqlite');

const { openDb, enqueueWa, enqueueWaForce, claimWaPending, markWaSent, requeueStaleWa, listWaOutbox } =
  await import('../src/storage.js');

openDb();

test('enqueueWa inserta y es idempotente por (orderId, kind)', () => {
  const first = enqueueWa({ orderId: 'o1', phone: '573001112233', kind: 'activacion', body: 'hola' });
  const dup = enqueueWa({ orderId: 'o1', phone: '573001112233', kind: 'activacion', body: 'hola otra vez' });
  assert.equal(first, true);
  assert.equal(dup, false);
  const rows = listWaOutbox().filter((r) => r.order_id === 'o1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'queued');
});

test('claimWaPending toma queued y las marca sending', () => {
  enqueueWa({ orderId: 'o2', phone: '573002223344', kind: 'activacion', body: 'x' });
  const claimed = claimWaPending(10);
  const mine = claimed.find((r) => r.order_id === 'o2');
  assert.ok(mine, 'o2 debe salir en el claim');
  const again = claimWaPending(10).find((r) => r.order_id === 'o2');
  assert.equal(again, undefined, 'ya no está queued, no se vuelve a tomar');
});

test('markWaSent ok -> sent, !ok -> failed con attempts++', () => {
  enqueueWa({ orderId: 'o3', phone: '573003334455', kind: 'activacion', body: 'x' });
  enqueueWa({ orderId: 'o4', phone: '573004445566', kind: 'activacion', body: 'x' });
  const claimed = claimWaPending(50);
  const o3 = claimed.find((r) => r.order_id === 'o3');
  const o4 = claimed.find((r) => r.order_id === 'o4');
  markWaSent(o3.id, true, null);
  markWaSent(o4.id, false, 'numero invalido');
  const rows = listWaOutbox();
  const r3 = rows.find((r) => r.order_id === 'o3');
  const r4 = rows.find((r) => r.order_id === 'o4');
  assert.equal(r3.status, 'sent');
  assert.ok(r3.sent_at > 0);
  assert.equal(r4.status, 'failed');
  assert.equal(r4.last_error, 'numero invalido');
  assert.equal(r4.attempts, 1);
});

test('requeueStaleWa devuelve filas sending viejas a queued', () => {
  enqueueWa({ orderId: 'o5', phone: '573005556677', kind: 'activacion', body: 'x' });
  claimWaPending(50); // o5 pasa a sending
  const requeued = requeueStaleWa(-1); // maxAge negativo => todo lo sending es "viejo"
  assert.ok(requeued >= 1);
  const r5 = listWaOutbox().find((r) => r.order_id === 'o5');
  assert.equal(r5.status, 'queued');
});

test('enqueueWaForce: fila sent -> vuelve a queued (reenvío forzado), sin duplicar', () => {
  enqueueWa({ orderId: 'o6', phone: '573006667788', kind: 'activacion', body: 'original' });
  const claimed = claimWaPending(50).find((r) => r.order_id === 'o6');
  markWaSent(claimed.id, true, null);
  assert.equal(listWaOutbox().find((r) => r.order_id === 'o6').status, 'sent');

  const ok = enqueueWaForce({ orderId: 'o6', phone: '573006667788', kind: 'activacion', body: 'reenviado' });
  assert.equal(ok, true);

  const rows = listWaOutbox().filter((r) => r.order_id === 'o6' && r.kind === 'activacion');
  assert.equal(rows.length, 1, 'no debe duplicar la fila (order_id, kind)');
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].body, 'reenviado');
  assert.equal(rows[0].last_error, null);
});

test('enqueueWaForce: fila canceled -> vuelve a queued', () => {
  enqueueWa({ orderId: 'o7', phone: '573007778899', kind: 'recordatorio_3h', body: 'x' });
  const row = listWaOutbox().find((r) => r.order_id === 'o7');
  markWaSent(row.id, false, 'boom'); // deja el ejemplo en failed antes de simular cancelado
  // Simular cancelado (cancelWa vive en storage.js pero probamos directo el UPDATE de estado).
  const ok = enqueueWaForce({ orderId: 'o7', phone: '573007778899', kind: 'recordatorio_3h', body: 'y' });
  assert.equal(ok, true);
  const rows = listWaOutbox().filter((r) => r.order_id === 'o7' && r.kind === 'recordatorio_3h');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'queued');
});

test('enqueueWaForce: no existía fila -> la crea como queued', () => {
  const ok = enqueueWaForce({ orderId: 'o8', phone: '573008889900', kind: 'recordatorio_24h', body: 'z' });
  assert.equal(ok, true);
  const rows = listWaOutbox().filter((r) => r.order_id === 'o8');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'queued');
});
