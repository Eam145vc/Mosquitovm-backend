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

describe('Nequi egresos/no-venta (correos reales jul-2026, bug: sonaban como ingreso)', () => {
  test('"¡Enviaste plata por Bre-B!" (envío del dueño) → out, no anuncia', () => {
    const r = parseEmail({
      from: 'notificaciones@nequi.com.co',
      subject: '¡Enviaste plata por Bre-B!',
      text: '¡Realizaste un envío por Bre-B y todo salió bien! ¡Hola, EMMANUEL ALVAREZ MARTINEZ! ' +
        'Enviaste de manera exitosa 60.000 a la llave @bbvaeam086 de EMANUEL ALVAREZ MARTINEZ ' +
        'el 16 de julio de 2026 a las 5:58 p.m. Revisa el detalle en los movimientos de tu app.',
    });
    assert.equal(r.direction, 'out');
    assert.equal(r.amount, 60000);
    assert.equal(r.bank, 'nequi');
  });

  test('"¡Pago exitoso!" (Hiciste un pago en Mercadopago por $200.000) → out', () => {
    const r = parseEmail({
      from: 'somos@nequi.com.co',
      subject: '¡Pago exitoso!',
      text: '¡Pago exitoso! Hiciste un pago en Mercadopago Colombia S.A. por $200.000 ' +
        'Fecha: El 16 de julio de 2026 Hora: 1:30 p. m. CUS: 486099450 ' +
        'Puedes ingresar a tu app Nequi en la opción de Movimientos y revisar el detalle de este pago.',
    });
    assert.equal(r.direction, 'out');
    assert.equal(r.amount, 200000);
  });

  test('"Te hicimos un reverso." (devolución) → out, no es venta', () => {
    const r = parseEmail({
      from: 'notificaciones@nequi.com.co',
      subject: 'Te hicimos un reverso.',
      text: 'Tu dinero ya está devuelta Recibiste un reverso por $ 27.119,66. ' +
        'Ya lo puedes ver reflejado en tu saldo disponible en Nequi.',
    });
    assert.equal(r.direction, 'out');
    assert.equal(r.amount, 27119);
  });

  test('"Cambiaste los montos en tu Nequi" (config con cifras) → jamás in', () => {
    const r = parseEmail({
      from: 'notificaciones@nequi.com.co',
      subject: 'Cambiaste los montos en tu Nequi',
      text: 'Actualizaste tus topes: ahora puedes enviar hasta $2.000.000 por día.',
    });
    assert.notEqual(r?.direction, 'in');
  });

  test('regresión: "¡Recibiste plata por Bre-B!" sigue siendo ingreso', () => {
    const r = parseEmail({
      from: 'notificaciones@nequi.com.co',
      subject: '¡Recibiste plata por Bre-B!',
      text: 'Recibiste $10.000 de PEDRO PEREZ.',
    });
    assert.equal(r.direction, 'in');
    assert.equal(r.amount, 10000);
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
