import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmail } from '../src/parsers/index.js';

describe('Bancolombia', () => {
  test('Recibiste una transferencia por $50.000', () => {
    const r = parseEmail({
      from: 'alertasynotificaciones@notificacionesbancolombia.com',
      subject: 'Bancolombia te informa',
      text: 'Hola Juan! Recibiste una transferencia por $50.000 de PEDRO PEREZ.',
    });
    assert.equal(r.amount, 50000);
    assert.equal(r.bank, 'bancolombia');
    assert.equal(r.currency, 'COP');
  });

  test('abono por $12.345', () => {
    const r = parseEmail({
      from: 'alertas@bancolombia.com.co',
      subject: 'Abono a tu cuenta',
      text: 'Te informamos un abono por $12.345 a tu cuenta de ahorros.',
    });
    assert.equal(r.amount, 12345);
    assert.equal(r.bank, 'bancolombia');
  });

  test('Recibiste $1.000.000 (un millon)', () => {
    const r = parseEmail({
      from: 'alertas@bancolombia.com',
      subject: 'Pago recibido',
      text: 'Recibiste un abono por $1.000.000 hoy.',
    });
    assert.equal(r.amount, 1000000);
  });
});

describe('Nequi', () => {
  test('Te enviaron $30.000', () => {
    const r = parseEmail({
      from: 'notificaciones@nequi.com.co',
      subject: 'Te enviaron plata',
      text: 'Maria te envio $30.000 por Nequi.',
    });
    assert.equal(r.amount, 30000);
    assert.equal(r.bank, 'nequi');
  });

  test('Recibiste $5.500 de Pedro', () => {
    const r = parseEmail({
      from: 'no-reply@nequi.com',
      subject: 'Recibiste plata',
      text: 'Recibiste $5.500 de Pedro Gomez.',
    });
    assert.equal(r.amount, 5500);
    assert.equal(r.bank, 'nequi');
  });
});

describe('Daviplata', () => {
  test('Recibiste $20.000 en Daviplata', () => {
    const r = parseEmail({
      from: 'notificaciones@davivienda.com',
      subject: 'Daviplata: tienes plata nueva',
      text: 'Recibiste $20.000 en tu Daviplata.',
    });
    assert.equal(r.amount, 20000);
    assert.equal(r.bank, 'daviplata');
  });
});

describe('Davivienda (no Daviplata)', () => {
  test('Abono a cuenta', () => {
    const r = parseEmail({
      from: 'notificaciones@davivienda.com',
      subject: 'Abono en su cuenta',
      text: 'Le informamos que su cuenta recibio un abono por $100.000.',
    });
    assert.equal(r.amount, 100000);
    assert.equal(r.bank, 'davivienda');
  });
});

describe('No matches', () => {
  test('Email no de banco -> null', () => {
    const r = parseEmail({
      from: 'amigo@gmail.com',
      subject: 'Hola',
      text: 'Que tal estas?',
    });
    assert.equal(r, null);
  });

  test('Email de banco sin monto -> null', () => {
    const r = parseEmail({
      from: 'alertas@bancolombia.com',
      subject: 'Promo',
      text: 'Te ofrecemos una tarjeta de credito.',
    });
    assert.equal(r, null);
  });
});

describe('HTML fallback', () => {
  test('Parsea HTML quitando tags', () => {
    const r = parseEmail({
      from: 'alertas@bancolombia.com',
      subject: 'Abono',
      text: '',
      html: '<html><body><p>Recibiste <strong>$15.000</strong> de Pedro</p></body></html>',
    });
    assert.equal(r.amount, 15000);
    assert.equal(r.bank, 'bancolombia');
  });
});

describe('Bancolombia Bre-B (llave + cuenta para ruteo multipunto)', () => {
  // Texto real de un email de pago Bre-B de Bancolombia (jun-2026).
  const textBreB =
    'Bancolombia: TEST, recibiste un pago de EMMANUEL ALVAREZ MARTINEZ por $100.00 ' +
    'en tu cuenta *4369 conectado a la llave @test883 el 09/06/2026 a las 11:24. ' +
    'Con codigo QR es facil y de una. Dudas al 018000912345.';

  test('extrae la llave alfanumérica @test883', () => {
    const r = parseEmail({ from: 'alertasynotificaciones@bancolombia.com', subject: 'Alertas y Notificaciones', text: textBreB });
    assert.equal(r.brebKey, '@test883');
  });

  test('extrae los últimos dígitos de la cuenta (*4369)', () => {
    const r = parseEmail({ from: 'alertasynotificaciones@bancolombia.com', subject: 'Alertas y Notificaciones', text: textBreB });
    assert.equal(r.account, '4369');
  });

  test('sigue extrayendo el monto del pago Bre-B', () => {
    const r = parseEmail({ from: 'alertasynotificaciones@bancolombia.com', subject: 'Alertas y Notificaciones', text: textBreB });
    assert.equal(r.amount, 100);
    assert.equal(r.direction, 'in');
  });

  test('email sin llave → brebKey null, no rompe', () => {
    const r = parseEmail({
      from: 'alertasynotificaciones@notificacionesbancolombia.com',
      subject: 'Bancolombia te informa',
      text: 'Recibiste una transferencia por $50.000 de PEDRO PEREZ.',
    });
    assert.equal(r.amount, 50000);
    assert.equal(r.brebKey ?? null, null);
  });
});
