import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// config.js (vía logger.js) valida env con Zod: setear ANTES de importar el módulo.
process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY ||= 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';

const { recordBankSample, onIncident, snapshot, _reset,
  SLOW_PRECISE_MS, WINDOW_MS, CLEAR_MS, MIN_GAP_MS } =
  await import('../src/bank-status.js');

const T0 = 1_800_000_000_000; // epoch base fija (el módulo recibe `now` inyectado)
const LENTO = SLOW_PRECISE_MS + 5_000;
const RAPIDO = 5_000;
const sample = (ms, now, bank = 'bancolombia') =>
  recordBankSample({ bank, bankToBackendMs: ms, precise: true }, now);

let fired;
beforeEach(() => {
  _reset();
  fired = [];
  onIncident((bank) => { fired.push(bank); });
});

test('un pago lento aislado NO dispara (no sensible)', () => {
  sample(LENTO, T0);
  sample(RAPIDO, T0 + 60_000);
  sample(RAPIDO, T0 + 120_000);
  assert.equal(fired.length, 0);
  assert.equal(snapshot(T0 + 120_000).find((b) => b.bank === 'bancolombia').demorado, false);
});

test('dos lentos tampoco disparan; el tercero (siendo mayoría) sí — una sola vez', () => {
  sample(LENTO, T0);
  sample(LENTO, T0 + 120_000);
  assert.equal(fired.length, 0);
  sample(LENTO, T0 + 240_000);
  assert.deepEqual(fired, ['bancolombia']);
  // más lentos dentro del mismo incidente NO re-disparan
  sample(LENTO, T0 + 300_000);
  sample(LENTO, T0 + 360_000);
  assert.equal(fired.length, 1);
  assert.equal(snapshot(T0 + 360_000)[0].demorado, true);
});

test('3 lentos pero minoría (muchos pagos rápidos) NO dispara', () => {
  for (let i = 0; i < 8; i++) sample(RAPIDO, T0 + i * 30_000);
  sample(LENTO, T0 + 300_000);
  sample(LENTO, T0 + 330_000);
  sample(LENTO, T0 + 360_000);
  assert.equal(fired.length, 0);
});

test('lentos regados fuera de la ventana de 15 min NO disparan', () => {
  sample(LENTO, T0);
  sample(LENTO, T0 + WINDOW_MS + 60_000);
  sample(LENTO, T0 + 2 * (WINDOW_MS + 60_000));
  assert.equal(fired.length, 0);
});

test('el incidente cierra tras 10 min sin lentos y el snapshot expira solo', () => {
  sample(LENTO, T0);
  sample(LENTO, T0 + 60_000);
  sample(LENTO, T0 + 120_000);
  assert.equal(fired.length, 1);
  // aún abierto justo antes del cierre
  assert.equal(snapshot(T0 + 120_000 + CLEAR_MS - 1)[0].demorado, true);
  // expirado sin necesidad de muestras nuevas
  assert.equal(snapshot(T0 + 120_000 + CLEAR_MS + 1)[0].demorado, false);
});

test('tras cerrar, otro brote re-dispara solo si pasó el gap de 1 h', () => {
  sample(LENTO, T0);
  sample(LENTO, T0 + 60_000);
  sample(LENTO, T0 + 120_000);
  assert.equal(fired.length, 1);
  // brote nuevo a los 20 min (ya cerró por CLEAR_MS, pero NO pasó MIN_GAP_MS): abre sin sonar
  const T1 = T0 + 120_000 + CLEAR_MS + 60_000;
  sample(LENTO, T1);
  sample(LENTO, T1 + 60_000);
  sample(LENTO, T1 + 120_000);
  assert.equal(fired.length, 1, 'no debe bombardear avisos seguidos');
  // brote pasada 1 h desde el primer aviso: vuelve a sonar
  const T2 = T0 + MIN_GAP_MS + CLEAR_MS + 60_000;
  sample(LENTO, T2);
  sample(LENTO, T2 + 60_000);
  sample(LENTO, T2 + 120_000);
  assert.equal(fired.length, 2);
});

test('el incidente es POR banco: nequi lento no marca bancolombia', () => {
  sample(LENTO, T0, 'nequi');
  sample(LENTO, T0 + 60_000, 'nequi');
  sample(LENTO, T0 + 120_000, 'nequi');
  sample(RAPIDO, T0 + 130_000, 'bancolombia');
  assert.deepEqual(fired, ['nequi']);
  const snap = snapshot(T0 + 130_000);
  assert.equal(snap.find((b) => b.bank === 'nequi').demorado, true);
  assert.equal(snap.find((b) => b.bank === 'bancolombia').demorado, false);
});

test('medición imprecisa usa umbral más alto (90s imprecisos NO cuentan como lento)', () => {
  for (const dt of [0, 60_000, 120_000]) {
    recordBankSample({ bank: 'bancolombia', bankToBackendMs: SLOW_PRECISE_MS + 5_000, precise: false }, T0 + dt);
  }
  assert.equal(fired.length, 0, 'con ±60s de error, 95s puede ser un pago normal');
});
