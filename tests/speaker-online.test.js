import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js (vía logger.js) valida env con Zod: setear ANTES de importar el módulo.
process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY ||= 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const { filterOnline, PING_GRACE_MS } = await import('../src/speaker-online.js');

const T0 = 1_800_000_000_000; // epoch base fija (deps inyectadas, sin reloj real)

// deps fake: `respond` = speakers que "contestan" el getinfo (last_seen se
// actualiza al momento del ping), `seenBefore` = last_seen previo por speaker.
function fakeDeps({ respond = [], seenBefore = {} } = {}) {
  const seen = new Map(Object.entries(seenBefore));
  const pinged = [];
  return {
    pinged,
    deps: {
      publish: async (spkr, payload, opts) => {
        pinged.push({ spkr, payload, qos: opts?.qos });
        if (respond.includes(spkr)) seen.set(spkr, T0); // "respondió" al ping
      },
      devices: () => [...seen.entries()].map(([spkr_id, last_seen]) => ({ spkr_id, last_seen })),
      sleep: async () => {},
      now: () => T0,
    },
  };
}

test('solo pasan los que responden el ping', async () => {
  const { deps, pinged } = fakeDeps({ respond: ['spkr-001'] });
  const online = await filterOnline(['spkr-001', 'spkr-002'], deps);
  assert.deepEqual(online, ['spkr-001']);
  // pingueó a TODOS los candidatos, con qos 0 (nada encolado para offline)
  assert.deepEqual(pinged.map((p) => p.spkr), ['spkr-001', 'spkr-002']);
  assert.ok(pinged.every((p) => p.payload.cmd === 'getinfo' && p.qos === 0));
});

test('un status recién entrado (dentro del margen) cuenta como online', async () => {
  const { deps } = fakeDeps({ seenBefore: { 'spkr-003': T0 - PING_GRACE_MS + 1000 } });
  assert.deepEqual(await filterOnline(['spkr-003'], deps), ['spkr-003']);
});

test('last_seen viejo o speaker no registrado = offline', async () => {
  const { deps } = fakeDeps({ seenBefore: { 'spkr-004': T0 - PING_GRACE_MS - 1000 } });
  assert.deepEqual(await filterOnline(['spkr-004', 'spkr-nunca-visto'], deps), []);
});

test('lista vacía no pinguea nada', async () => {
  const { deps, pinged } = fakeDeps();
  assert.deepEqual(await filterOnline([], deps), []);
  assert.equal(pinged.length, 0);
});
