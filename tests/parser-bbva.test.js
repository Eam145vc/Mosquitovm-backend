import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matches, parse } from '../src/parsers/bbva.js';
import { parseEmail } from '../src/parsers/index.js';

// Texto REAL del correo Bre-B de BBVA (jul-2026), tras el stripHtml del backend.
const BREB_REAL =
  'Recibiste dinero en tu cuenta a través de Bre-B Tu dinero ya está disponible ' +
  'Emanuel Alvarez , ya está disponible en tu Cuenta BBVA el dinero que EMMANUEL ' +
  'ALVAREZ MARTINEZ envió a tu llave de Alfanumérica. Ingresa a nuestros canales ' +
  'digitales para confirmar tu nuevo saldo. Detalles de la operación Fecha y hora ' +
  '2026/07/14 10:59 Valor recibido $ 2,00 Persona que envía EMMANUEL ALVAREZ MARTINEZ ' +
  'Tipo de llave Alfanumérica Cuenta destino *****6365 Código de operación ' +
  '10025826415270422590157636204918224 Hazlo fácil, hazlo desde tu app';

describe('parser bbva - matches', () => {
  test('from notificacionesBreB@bbva.com', () =>
    assert.equal(matches('notificacionesbreb@bbva.com', 'Recibiste dinero en tu cuenta a través de Bre-B.'), true));
  test('from BBVA@bbvanet.com.co', () =>
    assert.equal(matches('bbva@bbvanet.com.co', 'Actualizaste tu email principal'), true));
  test('no matchea otros bancos', () =>
    assert.equal(matches('alertasynotificaciones@notificacionesbancolombia.com', 'Bancolombia te informa'), false));
});

describe('parser bbva - parse (correo real Bre-B)', () => {
  test('extrae monto, ref y cuenta del correo real', () => {
    const r = parse(BREB_REAL);
    assert.ok(r);
    assert.equal(r.amount, 2);
    assert.equal(r.bank, 'bbva');
    assert.equal(r.direction, 'in');
    assert.equal(r.ref, '10025826415270422590157636204918224');
    assert.equal(r.account, '6365');
  });
  test('monto con miles y coma decimal ($ 1.500,00)', () => {
    const r = parse('Detalles de la operación Valor recibido $ 1.500,00 Persona que envía JUAN');
    assert.equal(r.amount, 1500);
  });
  test('monto grande ($ 1.234.567,00)', () => {
    const r = parse('Valor recibido $ 1.234.567,00');
    assert.equal(r.amount, 1234567);
  });
  test('correo NO-pago (Actualizaste tu email) devuelve null', () => {
    assert.equal(parse('Actualizaste tu email principal. Si no fuiste tú, llama a la Línea BBVA.'), null);
  });
  test('marketing con precio NO se anuncia (sin patrón genérico)', () => {
    assert.equal(parse('Estrena tarjeta BBVA con cuota de manejo de $ 0 y beneficios por $ 50.000'), null);
  });
});

describe('parser bbva - vía registry parseEmail', () => {
  test('el registry rutea el correo real a bbva', () => {
    const r = parseEmail({
      from: 'notificacionesBreB@bbva.com',
      subject: 'Recibiste dinero en tu cuenta a través de Bre-B.',
      text: BREB_REAL,
    });
    assert.ok(r);
    assert.equal(r.parser, 'bbva');
    assert.equal(r.amount, 2);
  });
});
