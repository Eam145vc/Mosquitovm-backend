import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { amountToWavs, buildVoiceMessage, speechQuality, FRASES_LARGAS } from '../src/amount-to-wavs.js';

describe('amountToWavs - solo el numero', () => {
  test('0', () => assert.deepEqual(amountToWavs(0), ['000']));
  test('1', () => assert.deepEqual(amountToWavs(1), ['001']));
  test('15', () => assert.deepEqual(amountToWavs(15), ['015']));
  test('25', () => assert.deepEqual(amountToWavs(25), ['025']));
  test('30', () => assert.deepEqual(amountToWavs(30), ['030']));
  test('31', () => assert.deepEqual(amountToWavs(31), ['031', '001']));
  test('45', () => assert.deepEqual(amountToWavs(45), ['043', '063', '005']));
  test('50', () => assert.deepEqual(amountToWavs(50), ['044']));
  test('99', () => assert.deepEqual(amountToWavs(99), ['048', '063', '009']));
  test('100', () => assert.deepEqual(amountToWavs(100), ['049']));
  test('101 = ciento uno', () => assert.deepEqual(amountToWavs(101), ['050', '001']));
});

describe('amountToWavs casos cruciales', () => {
  test('123 = ciento veintitres', () => {
    assert.deepEqual(amountToWavs(123), ['050', '023']);
  });
  test('200 = doscientos', () => {
    assert.deepEqual(amountToWavs(200), ['051']);
  });
  test('305 = trescientos cinco', () => {
    assert.deepEqual(amountToWavs(305), ['052', '005']);
  });
  test('1500 = mil quinientos', () => {
    // miles=1 -> MIL='060'; resto=500 -> CENTENAS[500]='054'
    assert.deepEqual(amountToWavs(1500), ['060', '054']);
  });
  test('12345 = doce mil trescientos cuarenta y cinco', () => {
    assert.deepEqual(amountToWavs(12345), ['012', '060', '052', '043', '063', '005']);
  });
  test('100000 = cien mil', () => {
    assert.deepEqual(amountToWavs(100000), ['049', '060']);
  });
  test('1000000 = un millon', () => {
    assert.deepEqual(amountToWavs(1000000), ['061']);  // un_millon = '061'
  });
  test('2500000 = dos millones quinientos mil', () => {
    assert.deepEqual(amountToWavs(2500000), ['002', '062', '054', '060']);
  });
});

describe('buildVoiceMessage - frases largas', () => {
  test('5000 usa frase larga', () => {
    // 5000 -> frase '103' (Recibiste cinco mil pesos)
    const got = buildVoiceMessage({ amount: 5000 });
    assert.equal(got, '103');
  });
  test('5000 + Bancolombia', () => {
    const got = buildVoiceMessage({ amount: 5000, bank: 'bancolombia' });
    assert.equal(got, '103-073-080');
  });
  test('10000 usa frase larga', () => {
    assert.equal(buildVoiceMessage({ amount: 10000 }), '104');
  });
  test('1000000 usa frase larga', () => {
    assert.equal(buildVoiceMessage({ amount: 1000000 }), '111');
  });
});

describe('buildVoiceMessage - fallback a concatenado', () => {
  test('7823 (monto raro) cae a concatenado', () => {
    // 070 Recibiste + 7=007 + 060 mil + 058 ochocientos + 023 veintitres (1 sola palabra) + 064 pesos
    const got = buildVoiceMessage({ amount: 7823 });
    assert.equal(got, '070-007-060-058-023-064');
  });
  test('1 peso (singular)', () => {
    const got = buildVoiceMessage({ amount: 1 });
    assert.equal(got, '070-001-065');  // 070 Recibiste + 001 uno + 065 peso
  });
  test('7823 + Nequi', () => {
    const got = buildVoiceMessage({ amount: 7823, bank: 'nequi' });
    assert.ok(got.endsWith('-073-081'));
  });
});

describe('speechQuality', () => {
  test('5000 = natural', () => {
    assert.equal(speechQuality(5000), 'natural');
  });
  test('5001 = concatenated', () => {
    assert.equal(speechQuality(5001), 'concatenated');
  });
  test('1000000 = natural', () => {
    assert.equal(speechQuality(1000000), 'natural');
  });
});

describe('cobertura de frases largas', () => {
  test('todas las claves de FRASES_LARGAS son numericas', () => {
    for (const k of Object.keys(FRASES_LARGAS)) {
      assert.ok(Number.isFinite(Number(k)));
    }
  });
});
