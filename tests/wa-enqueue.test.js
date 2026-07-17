import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'waenq-')), 'db.sqlite');
process.env.ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.MQTT_URL = 'mqtt://d'; process.env.MQTT_USERNAME = 'd'; process.env.MQTT_PASSWORD = 'd';

const { openDb, listWaOutbox, createOrder, updateOrder, getOrder } = await import('../src/storage.js');
const { normalizePhoneCO, buildWaBody, enqueueWhatsApp, qrPhonesSet } = await import('../src/wa-enqueue.js');
openDb();

test('normalizePhoneCO: celular de 10 dígitos con 3 => 57 + número', () => {
  assert.equal(normalizePhoneCO('3001112233'), '573001112233');
  assert.equal(normalizePhoneCO('300 111 2233'), '573001112233');
  assert.equal(normalizePhoneCO('(300) 111-2233'), '573001112233');
});

test('normalizePhoneCO: ya viene con 57 o +57 => se respeta', () => {
  assert.equal(normalizePhoneCO('+57 300 111 2233'), '573001112233');
  assert.equal(normalizePhoneCO('573001112233'), '573001112233');
});

test('normalizePhoneCO: número raro => se limpia pero se devuelve (política siempre-intentar)', () => {
  assert.equal(normalizePhoneCO('601 5551234'), '6015551234'); // fijo Bogotá, no se descarta
  assert.equal(normalizePhoneCO('abc'), ''); // sin dígitos => vacío
});

test('buildWaBody incluye el link con el order id y es no vacío', () => {
  const body = buildWaBody({ id: 'ORD123', business_name: 'Tienda Ana' }, 'activacion');
  assert.match(body, /activar-pro\?order=ORD123/);
  assert.ok(body.length > 20);
});

test('buildWaBody es determinista por order.id (misma variante siempre)', () => {
  const a = buildWaBody({ id: 'SAME', business_name: 'X' }, 'recordatorio_3h');
  const b = buildWaBody({ id: 'SAME', business_name: 'X' }, 'recordatorio_3h');
  assert.equal(a, b);
});

test('enqueueWhatsApp sin teléfono => false, no encola', () => {
  const ok = enqueueWhatsApp({ id: 'NOPHONE', phone: '', business_name: 'X' }, 'activacion');
  assert.equal(ok, false);
  assert.equal(listWaOutbox().some((r) => r.order_id === 'NOPHONE'), false);
});

test('enqueueWhatsApp con teléfono => encola normalizado', () => {
  const ok = enqueueWhatsApp({ id: 'ORD9', phone: '300 111 2233', business_name: 'X' }, 'activacion');
  assert.equal(ok, true);
  const row = listWaOutbox().find((r) => r.order_id === 'ORD9');
  assert.equal(row.phone, '573001112233');
  assert.equal(row.kind, 'activacion');
});

test('onboarding por CLIENTE: otra orden del mismo teléfono con QR bloquea el "sube tu QR"', () => {
  // Orden A del cliente: con QR subido. Orden B (duplicada, mismo teléfono): sin QR.
  const a = createOrder({ amountCents: 8_900_000 });
  updateOrder(a, { status: 'paid', phone: '311 222 3344', qr_path: `${a}.png` });
  const b = createOrder({ amountCents: 8_900_000 });
  updateOrder(b, { status: 'paid', phone: '+57 311 222 3344', business_name: 'Duplicada' });

  assert.ok(qrPhonesSet().has('573112223344'), 'el set debe tener el teléfono normalizado');
  // El recordatorio a la duplicada NO debe encolarse aunque ella no tenga QR.
  assert.equal(enqueueWhatsApp(getOrder(b), 'recordatorio_3h'), false);
  assert.equal(enqueueWhatsApp(getOrder(b), 'activacion'), false);
  // Un kind NO-onboarding del mismo cliente sí pasa (ej. 'envio' no pide QR)…
  // …y otro cliente sin QR sí recibe su onboarding normal.
  const c = createOrder({ amountCents: 8_900_000 });
  updateOrder(c, { status: 'paid', phone: '300 999 8877', business_name: 'Otro Cliente' });
  assert.equal(enqueueWhatsApp(getOrder(c), 'activacion'), true);
});
