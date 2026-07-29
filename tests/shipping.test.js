import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  envioPorDane, ENVIO_METRO, ENVIO_PRINCIPALES, ENVIO_INTERMEDIAS, ENVIO_LEJANAS,
} from '../src/shipping.js';

describe('envioPorDane - tarifas por zona', () => {
  test('Medellín y Valle de Aburrá = $11.000', () => {
    assert.equal(envioPorDane('05001'), ENVIO_METRO); // Medellín
    assert.equal(envioPorDane('05266'), ENVIO_METRO); // Envigado
    assert.equal(envioPorDane('05088'), ENVIO_METRO); // Bello
    assert.equal(envioPorDane('05631'), ENVIO_METRO); // Sabaneta
  });

  test('capitales principales y su área metro = $15.000', () => {
    assert.equal(envioPorDane('11001'), ENVIO_PRINCIPALES); // Bogotá
    assert.equal(envioPorDane('76001'), ENVIO_PRINCIPALES); // Cali
    assert.equal(envioPorDane('08001'), ENVIO_PRINCIPALES); // Barranquilla
    assert.equal(envioPorDane('66170'), ENVIO_PRINCIPALES); // Dosquebradas
    assert.equal(envioPorDane('25754'), ENVIO_PRINCIPALES); // Soacha
  });

  test('resto del país = $20.000 (intermedias)', () => {
    assert.equal(envioPorDane('05045'), ENVIO_INTERMEDIAS); // Apartadó (Antioquia no-metro)
    assert.equal(envioPorDane('54003'), ENVIO_INTERMEDIAS); // Ábrego
    assert.equal(envioPorDane('15238'), ENVIO_INTERMEDIAS); // Duitama
    assert.equal(envioPorDane('18001'), ENVIO_INTERMEDIAS); // Florencia (Caquetá)
  });

  test('departamentos lejanos = $25.000 (todo el depto, capital incluida)', () => {
    assert.equal(envioPorDane('91001'), ENVIO_LEJANAS); // Leticia (Amazonas)
    assert.equal(envioPorDane('27001'), ENVIO_LEJANAS); // Quibdó (Chocó)
    assert.equal(envioPorDane('88001'), ENVIO_LEJANAS); // San Andrés
    assert.equal(envioPorDane('99001'), ENVIO_LEJANAS); // Puerto Carreño (Vichada)
    assert.equal(envioPorDane('81001'), ENVIO_LEJANAS); // Arauca
  });

  test('sin DANE o inválido cae a intermedias ($20.000), nunca al tope', () => {
    assert.equal(envioPorDane(null), ENVIO_INTERMEDIAS);
    assert.equal(envioPorDane(''), ENVIO_INTERMEDIAS);
    assert.equal(envioPorDane('Medellín'), ENVIO_INTERMEDIAS);
    assert.equal(envioPorDane('123'), ENVIO_INTERMEDIAS);
  });

  test('el tope es $25.000: ninguna tarifa lo supera', () => {
    for (const t of [ENVIO_METRO, ENVIO_PRINCIPALES, ENVIO_INTERMEDIAS, ENVIO_LEJANAS]) {
      assert.ok(t <= 25_000);
    }
  });
});
