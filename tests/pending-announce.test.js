import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setPending, clearPending, takePending, PENDING_MAX_AGE_MS } from '../src/pending-announce.js';

const T0 = 1_800_000_000_000; // epoch base fija (now inyectado, sin reloj real)

test('guarda y entrega el pendiente una sola vez', () => {
  setPending('spkr-010', { playAudibleMsg: '076-103-005', amount: 5000 }, () => T0);
  const p = takePending('spkr-010', () => T0 + 1000);
  assert.equal(p.playAudibleMsg, '076-103-005');
  assert.equal(p.amount, 5000);
  // segundo status seguido: ya no hay nada que entregar
  assert.equal(takePending('spkr-010', () => T0 + 2000), null);
});

test('un pago nuevo pisa al anterior: solo queda el último', () => {
  setPending('spkr-011', { playAudibleMsg: 'viejo', amount: 1000 }, () => T0);
  setPending('spkr-011', { playAudibleMsg: 'ultimo', amount: 2000 }, () => T0 + 60_000);
  assert.equal(takePending('spkr-011', () => T0 + 61_000).playAudibleMsg, 'ultimo');
});

test('clearPending invalida el pendiente (el pago nuevo ya sonó en vivo)', () => {
  setPending('spkr-012', { playAudibleMsg: 'x', amount: 1000 }, () => T0);
  clearPending('spkr-012');
  assert.equal(takePending('spkr-012', () => T0), null);
});

test('un pendiente vencido (>24h) no se anuncia y queda borrado', () => {
  setPending('spkr-013', { playAudibleMsg: 'x', amount: 1000 }, () => T0);
  assert.equal(takePending('spkr-013', () => T0 + PENDING_MAX_AGE_MS + 1), null);
  assert.equal(takePending('spkr-013', () => T0), null); // borrado, no revive
});

test('speakers distintos no se pisan entre sí', () => {
  setPending('spkr-014', { playAudibleMsg: 'a', amount: 1 }, () => T0);
  setPending('spkr-015', { playAudibleMsg: 'b', amount: 2 }, () => T0);
  assert.equal(takePending('spkr-014', () => T0).playAudibleMsg, 'a');
  assert.equal(takePending('spkr-015', () => T0).playAudibleMsg, 'b');
});
