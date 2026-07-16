import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'wacloud-')), 'db.sqlite');
process.env.ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.MQTT_URL = 'mqtt://d'; process.env.MQTT_USERNAME = 'd'; process.env.MQTT_PASSWORD = 'd';

const { buildWaCloudPayload, sanitizeParam } = await import('../src/wa-cloud.js');
const { WA_TEMPLATES } = await import('../src/wa-templates.js');

const order = (extra = {}) => ({
  id: 'ord123',
  business_name: 'Tienda Don Carlos',
  address: 'Cra 10 # 20-30',
  city: 'Bogotá',
  delivery: 'online',
  amount_cents: 18_900_000,
  wompi_txn_id: null,
  ...extra,
});
const shipment = (extra = {}) => ({
  tracking: '240001234567',
  carrier: 'Coordinadora',
  tracking_url: 'https://coordinadora.com/rastreo/240001234567',
  ...extra,
});

const bodyParams = (p) => p.components.find((c) => c.type === 'body').parameters.map((x) => x.text);
const buttonParam = (p) => p.components.find((c) => c.type === 'button')?.parameters?.[0]?.text;

test('sanitizeParam: sin saltos de línea ni espacios múltiples (regla dura de Meta)', () => {
  assert.equal(sanitizeParam('hola\nmundo\t x'), 'hola mundo x');
  assert.equal(sanitizeParam('  '), '-');
  assert.equal(sanitizeParam(null, 'x'), 'x');
});

test('todos los kinds del sistema tienen plantilla', () => {
  const kinds = ['activacion', 'recordatorio_3h', 'recordatorio_24h', 'guia_creada',
    'envio', 'reparto', 'intento_entrega', 'entregado', 'correo', 'libreta'];
  for (const k of kinds) {
    const p = buildWaCloudPayload(order(), k, shipment());
    assert.ok(p, `kind sin plantilla: ${k}`);
    assert.ok(WA_TEMPLATES[p.name], `plantilla desconocida: ${p.name}`);
  }
  assert.equal(buildWaCloudPayload(order(), 'kind_inventado'), null);
});

test('nº de variables del payload = nº de {{n}} de la plantilla', () => {
  const kinds = ['activacion', 'recordatorio_3h', 'guia_creada', 'envio', 'reparto',
    'intento_entrega', 'entregado', 'correo', 'libreta'];
  for (const k of kinds) {
    for (const ord of [order(), order({ delivery: 'contraentrega' })]) {
      const p = buildWaCloudPayload(ord, k, shipment());
      const holes = (WA_TEMPLATES[p.name].body.match(/\{\{\d+\}\}/g) || []).length;
      assert.equal(bodyParams(p).length, holes, `${p.name}: params != huecos`);
    }
  }
});

test('activacion: nombre = primera palabra y botón con order.id', () => {
  const p = buildWaCloudPayload(order(), 'activacion');
  assert.equal(p.name, 'sono_activacion');
  assert.deepEqual(bodyParams(p), ['Tienda']);
  assert.equal(buttonParam(p), 'ord123');
});

test('ambos recordatorios comparten plantilla', () => {
  assert.equal(buildWaCloudPayload(order(), 'recordatorio_3h').name, 'sono_recordatorio_qr');
  assert.equal(buildWaCloudPayload(order(), 'recordatorio_24h').name, 'sono_recordatorio_qr');
});

test('guia_creada: rutea a variante COD solo en contraentrega sin pago online', () => {
  const online = buildWaCloudPayload(order(), 'guia_creada', shipment());
  assert.equal(online.name, 'sono_guia_creada');
  const cod = buildWaCloudPayload(order({ delivery: 'contraentrega' }), 'guia_creada', shipment());
  assert.equal(cod.name, 'sono_guia_creada_cod');
  assert.ok(bodyParams(cod).includes('$189.000'), 'monto COD formateado es-CO');
  // contraentrega YA pagada online (wompi_txn_id) => NO se pide plata
  const pagada = buildWaCloudPayload(
    order({ delivery: 'contraentrega', wompi_txn_id: 'txn1' }), 'guia_creada', shipment());
  assert.equal(pagada.name, 'sono_guia_creada');
});

test('guia_creada: datos de entrega en una sola línea', () => {
  const p = buildWaCloudPayload(order(), 'guia_creada', shipment());
  for (const v of bodyParams(p)) {
    assert.ok(!/[\n\t]/.test(v), `param con salto de línea: ${JSON.stringify(v)}`);
  }
  assert.ok(bodyParams(p).includes('Cra 10 # 20-30, Bogotá'));
});

test('sin shipment: fallbacks legibles, nunca variables vacías', () => {
  const p = buildWaCloudPayload(order(), 'guia_creada', null);
  for (const v of bodyParams(p)) assert.ok(v.length > 0, 'param vacío');
});

test('reparto: variante COD con monto', () => {
  const p = buildWaCloudPayload(order({ delivery: 'contraentrega' }), 'reparto', shipment());
  assert.equal(p.name, 'sono_reparto_cod');
  assert.equal(bodyParams(p)[1], '$189.000');
});

test('entregado y correo llevan botón con order.id (URL con correo=1 fija en la plantilla)', () => {
  for (const k of ['entregado', 'correo', 'libreta']) {
    const p = buildWaCloudPayload(order(), k);
    assert.equal(buttonParam(p), 'ord123', `${k} sin botón`);
  }
});

test('orden sin business_name: fallback y no revienta', () => {
  const p = buildWaCloudPayload(order({ business_name: null }), 'activacion');
  assert.equal(bodyParams(p)[0], 'cliente');
});

// Reglas duras de Meta sobre el FORMATO de las plantillas: violarlas hace que la
// creación falle con INVALID_FORMAT y ese kind quede sin canal (failed permanente).
test('ninguna plantilla empieza ni termina con una variable', () => {
  for (const [name, def] of Object.entries(WA_TEMPLATES)) {
    assert.ok(!/^\{\{\d+\}\}/.test(def.body.trim()), `${name} empieza con variable`);
    assert.ok(!/\{\{\d+\}\}$/.test(def.body.trim()), `${name} termina con variable`);
  }
});

test('bodyExample cubre exactamente las variables de cada plantilla', () => {
  for (const [name, def] of Object.entries(WA_TEMPLATES)) {
    const holes = (def.body.match(/\{\{\d+\}\}/g) || []).length;
    assert.equal(def.bodyExample.length, holes, `${name}: ejemplos != variables`);
  }
});

test('dirección sin address no produce coma colgante', () => {
  const p = buildWaCloudPayload(order({ address: null }), 'guia_creada', shipment());
  assert.ok(bodyParams(p).includes('Bogotá'), 'debe quedar solo la ciudad');
  assert.ok(!bodyParams(p).some((v) => v.startsWith(',')), 'coma colgante');
  const sinNada = buildWaCloudPayload(order({ address: null, city: null }), 'guia_creada', shipment());
  assert.ok(bodyParams(sinNada).includes('sin dirección'));
});
