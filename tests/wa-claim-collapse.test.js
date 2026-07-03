import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'waclm-')), 'db.sqlite');
process.env.ENCRYPTION_KEY = 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.MQTT_URL = 'mqtt://d'; process.env.MQTT_USERNAME = 'd'; process.env.MQTT_PASSWORD = 'd';
const { openDb, enqueueWa, claimWaPending, listWaOutbox } = await import('../src/storage.js');
openDb();

// Backlog con la PC apagada: activación + recordatorio del MISMO pedido en cola.
// Al entregar al agente debe salir UNO solo (el más reciente); el otro se cancela.
test('claim colapsa onboarding acumulado de una orden: sale 1, el resto se cancela', () => {
  enqueueWa({ orderId: 'C1', phone: '573001112233', kind: 'activacion', body: 'sube tu QR' });
  enqueueWa({ orderId: 'C1', phone: '573001112233', kind: 'recordatorio_3h', body: 'recuerda subir tu QR' });
  const claimed = claimWaPending(10).filter((m) => m.order_id === 'C1');
  assert.equal(claimed.length, 1, 'debe entregarse UN solo mensaje de onboarding');
  const rows = listWaOutbox().filter((w) => w.order_id === 'C1');
  assert.equal(rows.filter((w) => w.status === 'sending').length, 1);
  assert.equal(rows.filter((w) => w.status === 'canceled').length, 1);
});

test('claim NO colapsa kinds distintos de onboarding (guía + reparto salen ambos)', () => {
  enqueueWa({ orderId: 'C2', phone: '573001112244', kind: 'guia_creada', body: 'tu guía' });
  enqueueWa({ orderId: 'C2', phone: '573001112244', kind: 'reparto', body: 'va en reparto' });
  const claimed = claimWaPending(10).filter((m) => m.order_id === 'C2');
  assert.equal(claimed.length, 2, 'los avisos de tracking no se colapsan entre sí');
});

test('claim no toca onboarding de órdenes distintas', () => {
  enqueueWa({ orderId: 'C3', phone: '573001112255', kind: 'activacion', body: 'sube tu QR' });
  enqueueWa({ orderId: 'C4', phone: '573001112266', kind: 'activacion', body: 'sube tu QR' });
  const claimed = claimWaPending(10).filter((m) => ['C3', 'C4'].includes(m.order_id));
  assert.equal(claimed.length, 2, 'cada orden conserva su mensaje');
});
