import { test } from 'node:test';
import assert from 'node:assert/strict';

// wa-reminders.js importa logger.js -> config.js (Zod exige MQTT_*). Sin .env en este
// entorno, seteamos dummies ANTES de importar (mismo patrón que wa-outbox.test.js).
process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';

const { dueReminders } = await import('../src/wa-reminders.js');

const H = 3600 * 1000;
const now = 100 * 24 * H; // un "ahora" fijo grande

// stepOf de prueba: la orden trae su propio _step para el test.
const stepOf = (o) => o._step;
// confirmedAt de prueba: la orden trae _confirmedAt.
function make(id, ageH, step, status = 'pendiente_qr') {
  return { id, phone: '573001112233', business_name: 'X', status, _step: step, _confirmedAt: now - ageH * H };
}

test('orden confirmada hace 4h sin completar => recordatorio_3h, no 24h', () => {
  const due = dueReminders([make('a', 4, 2)], now, stepOf, (o) => o._confirmedAt);
  assert.deepEqual(due.map((d) => d.kind), ['recordatorio_3h']);
});

test('orden confirmada hace 25h sin completar => recordatorio_24h (y 3h)', () => {
  const due = dueReminders([make('b', 25, 2)], now, stepOf, (o) => o._confirmedAt);
  const kinds = due.map((d) => d.kind).sort();
  assert.deepEqual(kinds, ['recordatorio_24h', 'recordatorio_3h']);
});

test('orden con onboarding completo (step 3) => nada', () => {
  const due = dueReminders([make('c', 25, 3)], now, stepOf, (o) => o._confirmedAt);
  assert.equal(due.length, 0);
});

test('orden confirmada hace 1h => nada todavía', () => {
  const due = dueReminders([make('d', 1, 1)], now, stepOf, (o) => o._confirmedAt);
  assert.equal(due.length, 0);
});

test('orden no confirmada (status created) => nada', () => {
  const o = make('e', 30, 1, 'created');
  const due = dueReminders([o], now, stepOf, (o) => o._confirmedAt);
  assert.equal(due.length, 0);
});

test('orden COD (cod_pending) hace 4h sin completar => recordatorio_3h', () => {
  const o = make('f', 4, 2, 'cod_pending');
  const due = dueReminders([o], now, stepOf, (o) => o._confirmedAt);
  assert.deepEqual(due.map((d) => d.kind), ['recordatorio_3h']);
});
