import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB temporal + env dummy ANTES de importar storage/config (patrón wa-envio-body).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'libsto-')), 'db.sqlite');
process.env.ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
process.env.MQTT_URL = 'mqtt://d'; process.env.MQTT_USERNAME = 'd'; process.env.MQTT_PASSWORD = 'd';

const { openDb, recordPayment, paymentsAggregate, bestHours, paymentsAfter, paymentsPage } =
  await import('../src/storage.js');
const { bogotaDayStart, BOGOTA_OFFSET_MS, DAY_MS } = await import('../src/libreta-time.js');
openDb();

// Conexión raw aparte: los asserts de columnas van contra la fila REAL en SQLite,
// no contra lo que devuelva otra función del mismo módulo (evita acoplar tests).
const Database = (await import('better-sqlite3')).default;
const raw = new Database(process.env.DB_PATH);
const rawRows = (acc) => raw.prepare('SELECT * FROM payments WHERE account_id = ? ORDER BY id').all(acc);
const countAll = () => raw.prepare('SELECT COUNT(*) AS n FROM payments').get().n;

test('recordPayment guarda columnas nuevas', () => {
  const at = 1_750_000_000_000;
  const r = recordPayment({
    accountId: 'acc-cols', amount: 5000, bank: 'bancolombia', payer: 'JUAN PEREZ',
    brebKey: '@tienda1', speakerId: 'spkr-071', localName: 'Centro',
    unrouted: true, msgId: 'mid-cols-1', at,
  });
  assert.ok(r && r.id > 0, 'debe retornar la fila insertada con id');
  const row = rawRows('acc-cols')[0];
  assert.equal(row.breb_key, '@tienda1');
  assert.equal(row.speaker_id, 'spkr-071');
  assert.equal(row.local_name, 'Centro');
  assert.equal(row.unrouted, 1);
  assert.equal(row.msg_id, 'mid-cols-1');
  assert.equal(row.at, at); // `at` exacto: es el mismo timestamp del announce-log
});

test('recordPayment con msgId duplicado no inserta (dedupe idempotente)', () => {
  const p = { accountId: 'acc-dup', amount: 9000, bank: 'nequi', msgId: 'mid-repetido' };
  const primero = recordPayment(p);
  assert.ok(primero && primero.id > 0);
  const segundo = recordPayment(p);
  assert.equal(segundo, null, 'el segundo insert con mismo (accountId, msgId) debe retornar null');
  assert.equal(rawRows('acc-dup').length, 1);
});

test('recordPayment sin msgId permite duplicados legítimos', () => {
  // Dos ventas de $5.000 seguidas son NORMALES en un comercio: el índice único es
  // parcial (msg_id IS NOT NULL); sin msgId no puede haber dedupe de ningún tipo.
  const p = { accountId: 'acc-legit', amount: 5000, bank: 'bancolombia', msgId: null };
  assert.ok(recordPayment(p));
  assert.ok(recordPayment(p));
  assert.equal(rawRows('acc-legit').length, 2);
});

test('recordPayment sin accountId retorna null y no inserta', () => {
  const antes = countAll();
  assert.equal(recordPayment({ amount: 1000, bank: 'nequi' }), null);
  assert.equal(countAll(), antes);
});

test('paymentsAggregate respeta rango [from, to) y excluye amount<=0/null', () => {
  const A = 'acc-agg';
  recordPayment({ accountId: A, amount: 50, bank: 'x', at: 999 });     // antes del rango
  recordPayment({ accountId: A, amount: 100, bank: 'x', at: 1000 });   // dentro (borde from inclusivo)
  recordPayment({ accountId: A, amount: 200, bank: 'x', at: 1500 });   // dentro
  recordPayment({ accountId: A, amount: 300, bank: 'x', at: 1999 });   // dentro
  recordPayment({ accountId: A, amount: 400, bank: 'x', at: 2000 });   // fuera (borde to exclusivo)
  recordPayment({ accountId: A, amount: null, bank: 'x', at: 1500 });  // sin monto: no suma ni cuenta
  recordPayment({ accountId: A, amount: 0, bank: 'x', at: 1500 });     // monto 0: tampoco
  const g = paymentsAggregate(A, 1000, 2000);
  assert.equal(g.total, 600);
  assert.equal(g.n, 3);
});

test('paymentsAggregate incluye unrouted (son ventas reales)', () => {
  const A = 'acc-agg-unr';
  recordPayment({ accountId: A, amount: 700, bank: 'bancolombia', unrouted: true, at: 1500 });
  const g = paymentsAggregate(A, 1000, 2000);
  assert.equal(g.total, 700);
  assert.equal(g.n, 1);
});

test('bestHours agrupa por hora Bogotá (UTC-5), no por hora del VM', () => {
  const B = 'acc-hours';
  // 17:30/17:45 UTC = 12:30/12:45 Bogotá → hour 12 (dos ventas)
  recordPayment({ accountId: B, amount: 1000, bank: 'x', at: Date.UTC(2026, 0, 5, 17, 30) });
  recordPayment({ accountId: B, amount: 2000, bank: 'x', at: Date.UTC(2026, 0, 5, 17, 45) });
  // 04:00 UTC del 5-ene = 23:00 Bogotá del 4-ene → hour 23 (día anterior Bogotá)
  recordPayment({ accountId: B, amount: 3000, bank: 'x', at: Date.UTC(2026, 0, 5, 4, 0) });
  const rows = bestHours(B, 0);
  assert.equal(rows[0].hour, 12, 'la hora con más ventas va primera (ORDER BY n DESC)');
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].total, 3000);
  const h23 = rows.find((r) => r.hour === 23);
  assert.ok(h23, 'el pago de las 04:00 UTC debe caer en la hora 23 Bogotá');
  assert.equal(h23.n, 1);
  assert.equal(h23.total, 3000);
});

test('bogotaDayStart corta a medianoche Bogotá, no a medianoche UTC/local', () => {
  // 04:59 UTC del 3-jul = 23:59 Bogotá del 2-jul → medianoche Bogotá del 2-jul (05:00 UTC)
  assert.equal(bogotaDayStart(Date.UTC(2026, 6, 3, 4, 59)), Date.UTC(2026, 6, 2, 5, 0));
  // 05:00 UTC del 3-jul = 00:00 Bogotá del 3-jul exacto → medianoche del 3-jul
  assert.equal(bogotaDayStart(Date.UTC(2026, 6, 3, 5, 0)), Date.UTC(2026, 6, 3, 5, 0));
  assert.equal(BOGOTA_OFFSET_MS, 5 * 3600 * 1000);
  assert.equal(DAY_MS, 24 * 3600 * 1000);
});

test('paymentsAfter devuelve solo id > after, desc, y detecta gap con limit+1', () => {
  const C = 'acc-after';
  const ids = [];
  for (let i = 1; i <= 60; i++) {
    ids.push(recordPayment({ accountId: C, amount: 1000 + i, bank: 'x', at: 1_700_000_000_000 + i }).id);
  }
  const after = ids[4]; // id del pago #5 → quedan 55 más nuevos
  const rows = paymentsAfter(C, after); // limit default 51 = 50 + 1 centinela de gap
  assert.equal(rows.length, 51, 'limit+1 filas = el caller sabe que hay gap y corta a 50');
  assert.equal(rows[0].id, ids[59], 'más nuevo primero');
  assert.ok(rows.every((r) => r.id > after), 'ninguna fila con id <= after');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].id < rows[i - 1].id, 'orden id DESC estricto');
});

test('paymentsPage pagina hacia atrás sin solapes', () => {
  const D = 'acc-page';
  for (let i = 1; i <= 70; i++) {
    recordPayment({ accountId: D, amount: 2000 + i, bank: 'x', at: 1_710_000_000_000 + i });
  }
  const p1 = paymentsPage(D, Number.MAX_SAFE_INTEGER, 30); // primera página = los 30 más nuevos
  assert.equal(p1.length, 30);
  for (let i = 1; i < p1.length; i++) assert.ok(p1[i].id < p1[i - 1].id);

  const p2 = paymentsPage(D, p1.at(-1).id, 30); // nextBefore = último id de la página anterior
  assert.equal(p2.length, 30);
  assert.ok(p2[0].id < p1.at(-1).id, 'la página 2 arranca ESTRICTAMENTE antes del cursor');

  const p3 = paymentsPage(D, p2.at(-1).id, 30); // última página: menos de limit → no hay más
  assert.equal(p3.length, 10);

  const todos = new Set([...p1, ...p2, ...p3].map((r) => r.id));
  assert.equal(todos.size, 70, 'las 3 páginas cubren todo sin solapar ni perder filas');
});
