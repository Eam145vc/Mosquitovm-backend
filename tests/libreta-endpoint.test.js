import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// DB temporal + config dummy: se setea ANTES de importar storage/config/http-server
// (patrón wa-endpoints.test.js). HTTP_PORT=0 = puerto efímero (usamos app.inject,
// pero startHttp igual hace listen internamente).
process.env.MQTT_URL ||= 'mqtt://x';
process.env.MQTT_USERNAME ||= 'u';
process.env.MQTT_PASSWORD ||= 'p';
process.env.ENCRYPTION_KEY = 'GbIok8pliFrsQG7sKbCEpbN39/waCLO61IWAgWNIFk8=';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'libep-')), 'db.sqlite');
process.env.EMAIL_WEBHOOK_SECRET = 'testsecret123';
process.env.HTTP_PORT = '0';

const s = await import('../src/storage.js');
const { startHttp } = await import('../src/http-server.js');
s.openDb();

// Spy de onPaymentDetected: en producción es announcePayment (publica MQTT). Acá
// SOLO registra: si el pago unrouted llegara aquí, sería un bug (no debe sonar).
const pagosAnunciados = [];
const app = startHttp(() => {}, (p) => pagosAnunciados.push(p), () => {});
await app.ready();

// Lectura raw para verificar la fila persistida tal cual quedó en SQLite.
const Database = (await import('better-sqlite3')).default;
const raw = new Database(process.env.DB_PATH);

const get = (url) => app.inject({ method: 'GET', url });
const hexId = () => randomBytes(16).toString('hex');

let nAcc = 0;
function mkCuenta() {
  const id = `acc-lib-${++nAcc}`;
  s.upsertAccount({ id, email: `privado${nAcc}@gmail.com`, refreshToken: 'rt', authType: 'oauth' });
  return id;
}
function mkOrdenPagada({ accountId = null, businessName = 'Tienda Test' } = {}) {
  const id = s.createOrder({ amountCents: 8_900_000 });
  const patch = { status: 'paid', business_name: businessName };
  if (accountId) patch.account_id = accountId;
  s.updateOrder(id, patch);
  return id;
}

// ── 404 uniforme ──────────────────────────────────────────────────────────────

test('404 uniforme sin oráculo: inexistente, malformado, archivada y no pagada dan el MISMO body', async () => {
  const archivada = mkOrdenPagada();
  s.updateOrder(archivada, { prev_status: 'paid', status: 'archivada', archived_at: Date.now() });
  const noPagada = s.createOrder({ amountCents: 1000 }); // status 'created' → !canOnboard
  const variantes = [
    hexId(),                 // formato válido pero no existe
    'abc',                   // malformado corto
    'a'.repeat(31),          // 31 hex (uno menos)
    hexId().toUpperCase(),   // mayúsculas raras de un id inexistente
    archivada,               // kill-switch de revocación
    noPagada,                // orden sin pagar: no puede filtrar que "existe"
  ];
  const bodies = new Set();
  for (const v of variantes) {
    const r = await get(`/libreta/${v}`);
    assert.equal(r.statusCode, 404, `variante "${v}" debe dar 404`);
    bodies.add(r.body);
  }
  assert.equal(bodies.size, 1, 'el body debe ser IDÉNTICO en todas las variantes (sin oráculo)');
  assert.deepEqual(JSON.parse([...bodies][0]), { error: 'no encontrada' });
});

// ── Resumen ───────────────────────────────────────────────────────────────────

test('resumen ok: shape exacto y whitelist estricta (nada de infra ni PII)', async () => {
  const acc = mkCuenta();
  s.setAccountForward(acc, { alias: 'zzaliasoculto', forwardTo: 'reenvio-oculto@gmail.com' });
  const o1 = mkOrdenPagada({ accountId: acc, businessName: 'Panadería La Prueba' });
  const o2 = mkOrdenPagada({ accountId: acc });
  s.createDevice({ spkrId: 'spkr-771', mac: 'WL:AA', model: 'wifi' });
  s.assignDevice('spkr-771', o1);
  s.setDeviceBrebKey('spkr-771', { key: '@llaveoculta1', localName: 'Centro' });
  s.createDevice({ spkrId: 'spkr-772', mac: 'WL:BB', model: 'wifi' });
  s.assignDevice('spkr-772', o2);
  s.setDeviceBrebKey('spkr-772', { key: '@llaveoculta2', localName: 'Norte' });
  s.recordPayment({
    accountId: acc, amount: 25000, bank: 'bancolombia', payer: 'JUANSECRETO PEREZ',
    brebKey: '@llaveoculta1', speakerId: 'spkr-771', localName: 'Centro', msgId: 'msgid-oculto-1',
  });

  const r = await get(`/libreta/${o1}`);
  assert.equal(r.statusCode, 200);
  const body = r.json();

  // Keys EXACTAS del shape A9.2 (ni una más: cada key extra es superficie de fuga).
  assert.deepEqual(Object.keys(body).sort(), [
    'bestHours', 'businessName', 'cuenta', 'emailConnected', 'latestId', 'locales', 'month', 'multi',
    'nextBefore', 'now', 'ok', 'payments', 'prevMonthToDate', 'sub', 'today', 'yesterday',
  ]);
  assert.deepEqual(Object.keys(body.month).sort(), ['count', 'startAt', 'total']);
  assert.deepEqual(Object.keys(body.prevMonthToDate).sort(), ['count', 'total']);
  assert.deepEqual(Object.keys(body.payments[0]).sort(), ['amount', 'at', 'bank', 'id', 'key', 'local', 'unrouted']);
  assert.deepEqual(Object.keys(body.locales[0]).sort(), ['estado', 'key', 'lastSeenAt', 'name']);
  assert.deepEqual(Object.keys(body.sub).sort(), ['daysLeft', 'readOnly', 'state']);
  assert.deepEqual(Object.keys(body.today).sort(), ['count', 'startAt', 'total']);
  assert.deepEqual(Object.keys(body.yesterday).sort(), ['count', 'total']);
  assert.deepEqual(Object.keys(body.cuenta).sort(), ['cuotas', 'incluidoHasta', 'nextChargeAt', 'plan', 'sonos']);
  assert.equal(body.cuenta.sonos, 2, 'dos devices asignados → 2 Sonós');
  assert.equal(body.cuenta.plan, 'contado');
  assert.deepEqual(body.cuenta.cuotas, [], 'contado no debe traer cuotas pendientes');

  // Whitelist: el JSON serializado NO puede contener infra ni datos privados.
  // La llave Bre-B del PROPIO cliente SÍ se expone (campo `key`): es su dato (está
  // impresa en su QR) y separa locales homónimos en multipunto — decisión jul-2026.
  for (const prohibido of [
    'payer', 'breb_key', 'speaker_id', 'spkr-', 'msg_id',
    'JUANSECRETO', 'zzalias', '@gmail.com',
  ]) {
    assert.ok(!r.body.includes(prohibido), `el body no debe contener "${prohibido}"`);
  }
  // La llave del local viene como `key` (para el filtro por local del front).
  assert.ok(body.locales.some((l) => l.key === '@llaveoculta1'), 'la llave del propio cliente viaja en locales[].key');
  assert.equal(body.payments[0].key, '@llaveoculta1', 'la llave del pago viaja en payments[].key');

  assert.equal(body.emailConnected, true);
  assert.equal(body.businessName, 'Panadería La Prueba');
  assert.equal(body.multi, true, 'dos locales → multi:true');
  assert.equal(body.payments[0].amount, 25000);
  assert.equal(body.payments[0].local, 'Centro'); // el local sale por NOMBRE, nunca por spkr_id
  assert.equal(body.today.count, 1);
  assert.equal(body.today.total, 25000);
  assert.equal(typeof body.now, 'number');
});

test('empty state: orden pagada sin cuenta → emailConnected:false + connectUrl', async () => {
  const oid = mkOrdenPagada({ businessName: 'Sin Correo SAS' });
  const r = await get(`/libreta/${oid}`);
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.deepEqual(Object.keys(body).sort(), ['businessName', 'connectUrl', 'emailConnected', 'now', 'ok']);
  assert.equal(body.ok, true);
  assert.equal(body.emailConnected, false);
  assert.equal(body.businessName, 'Sin Correo SAS');
  // &correo=1 = el flujo de conectar correo al recibir el altavoz (activar-pro)
  assert.ok(body.connectUrl.endsWith(`/activar-pro/?order=${oid}&correo=1`), body.connectUrl);
});

// ── Feed ──────────────────────────────────────────────────────────────────────

test('feed after incremental: solo lo nuevo, latestId y today actualizados', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  const p1 = s.recordPayment({ accountId: acc, amount: 5000, bank: 'nequi' });
  const p2 = s.recordPayment({ accountId: acc, amount: 8000, bank: 'bancolombia' });

  const r = await get(`/libreta/${o}/feed?after=${p1.id}`);
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.gap, false);
  assert.equal(body.payments.length, 1, 'solo el pago posterior al cursor');
  assert.equal(body.payments[0].id, p2.id);
  assert.equal(body.payments[0].amount, 8000);
  assert.equal(body.latestId, p2.id, 'eco para el próximo poll');
  assert.equal(body.today.count, 2, 'el agregado de hoy incluye AMBOS pagos');
  assert.equal(body.today.total, 13000);
  assert.ok(Array.isArray(body.locales));
  assert.ok(body.sub && typeof body.sub.state === 'string');
});

test('feed gap: >50 pagos nuevos → gap:true y 50 filas (el cliente recarga el resumen)', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  for (let i = 1; i <= 60; i++) s.recordPayment({ accountId: acc, amount: 1000 + i, bank: 'x' });
  const r = await get(`/libreta/${o}/feed?after=0`);
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.gap, true);
  assert.equal(body.payments.length, 50);
});

test('feed before pagina sin solapes y termina con nextBefore null', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  for (let i = 1; i <= 70; i++) s.recordPayment({ accountId: acc, amount: 2000 + i, bank: 'x' });

  const vistos = new Set();
  const page = async (before) => {
    const r = await get(`/libreta/${o}/feed?before=${before}`);
    assert.equal(r.statusCode, 200);
    const body = r.json();
    for (const p of body.payments) {
      assert.ok(!vistos.has(p.id), `pago ${p.id} repetido entre páginas`);
      assert.ok(p.id < before, 'todas las filas son estrictamente anteriores al cursor');
      vistos.add(p.id);
    }
    return body;
  };

  const p1 = await page(Number.MAX_SAFE_INTEGER);
  assert.equal(p1.payments.length, 30); // limit default 30
  assert.equal(p1.nextBefore, p1.payments.at(-1).id);
  const p2 = await page(p1.nextBefore);
  assert.equal(p2.payments.length, 30);
  const p3 = await page(p2.nextBefore);
  assert.equal(p3.payments.length, 10);
  assert.equal(p3.nextBefore, null, 'página corta = no hay más historial');
  assert.equal(vistos.size, 70);
});

// ── Suspendida ────────────────────────────────────────────────────────────────

test('suspendida sigue leyendo: readOnly pero el feed sigue vivo', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  s.setSubStatus(acc, 'suspendida');
  s.recordPayment({ accountId: acc, amount: 12000, bank: 'nequi' });

  const r = await get(`/libreta/${o}`);
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.sub.state, 'suspendida');
  assert.equal(body.sub.readOnly, true);
  assert.equal(body.payments.length, 1, 'suspendida NO oculta el historial');

  // Ver la plata entrar sin que suene es el mejor incentivo de renovación:
  // los pagos NUEVOS deben seguir apareciendo en el feed de una cuenta suspendida.
  const nuevo = s.recordPayment({ accountId: acc, amount: 7000, bank: 'bancolombia' });
  const rf = await get(`/libreta/${o}/feed?after=${body.latestId}`);
  assert.equal(rf.statusCode, 200);
  assert.equal(rf.json().payments.length, 1);
  assert.equal(rf.json().payments[0].id, nuevo.id);
});

// ── Unrouted por webhook ─────────────────────────────────────────────────────

test('unrouted persiste y no suena: llave sin local → fila unrouted=1, sin anuncio', async () => {
  const acc = mkCuenta();
  s.setAccountForward(acc, { alias: 'multialias', forwardTo: 'dueño@gmail.com' });
  // 2 devices = multipunto: pickSpeaker rutea por llave; llave desconocida → unrouted.
  const o1 = mkOrdenPagada({ accountId: acc, businessName: 'Multi SAS' });
  const o2 = mkOrdenPagada({ accountId: acc });
  s.createDevice({ spkrId: 'spkr-881', mac: 'MU:AA', model: 'wifi' });
  s.assignDevice('spkr-881', o1);
  s.setDeviceBrebKey('spkr-881', { key: '@locala', localName: 'Local A' });
  s.createDevice({ spkrId: 'spkr-882', mac: 'MU:BB', model: 'wifi' });
  s.assignDevice('spkr-882', o2);
  s.setDeviceBrebKey('spkr-882', { key: '@localb', localName: 'Local B' });

  const anunciosAntes = pagosAnunciados.length;
  const r = await app.inject({
    method: 'POST',
    url: '/webhook/email',
    headers: { 'x-sono-secret': 'testsecret123', 'content-type': 'application/json' },
    payload: {
      alias: 'multialias',
      from: 'alertasynotificaciones@notificacionesbancolombia.com',
      subject: 'Bancolombia te informa Recepcion transferencia',
      // llave que NO coincide con ningún local de la cuenta → route.unrouted
      text: 'Bancolombia: Recibiste una transferencia por $25.000 de JUAN PEREZ en tu cuenta *4369 conectado a la llave @nomatch99 el 03/07/2026.',
    },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, true);

  // NO suena: onPaymentDetected (→ announcePayment → publishVoice) no se llamó.
  assert.equal(pagosAnunciados.length, anunciosAntes, 'un pago unrouted JAMÁS llega al anunciador');

  // Pero SÍ queda persistido para "La Libreta" (local por confirmar).
  const row = raw.prepare('SELECT * FROM payments WHERE account_id = ? ORDER BY id DESC').get(acc);
  assert.ok(row, 'el pago unrouted debe quedar en payments');
  assert.equal(row.unrouted, 1);
  assert.equal(row.speaker_id, null);
  assert.equal(row.breb_key, '@nomatch99');
  assert.equal(row.amount, 25000);

  const rl = await get(`/libreta/${o1}`);
  const venta = rl.json().payments.find((p) => p.id === row.id);
  assert.ok(venta, 'el unrouted aparece en La Libreta');
  assert.equal(venta.unrouted, true);
  assert.equal(venta.local, null);
});

// ── Montos gigantes ───────────────────────────────────────────────────────────

test('montos gigantes: $99.999.999 suma y se lista sin overflow', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  s.recordPayment({ accountId: acc, amount: 99_999_999, bank: 'bancolombia' });
  s.recordPayment({ accountId: acc, amount: 99_999_999, bank: 'bancolombia' });
  const body = (await get(`/libreta/${o}`)).json();
  assert.equal(body.today.total, 199_999_998); // SUM 64-bit de SQLite, sin truncar
  assert.equal(body.payments[0].amount, 99_999_999);
  const feed = (await get(`/libreta/${o}/feed?after=0`)).json();
  assert.equal(feed.payments[0].amount, 99_999_999);
});

// ── Cierre de mes ────────────────────────────────────────────────────────────

test('month y prevMonthToDate: mes Bogotá a la fecha vs mes pasado al MISMO punto', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  const now = Date.now();
  const OFF = 5 * 3600_000;
  const d = new Date(now - OFF);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + OFF;
  const prevStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) + OFF;

  s.recordPayment({ accountId: acc, amount: 40000, bank: 'nequi', at: now - 1000 });     // este mes
  s.recordPayment({ accountId: acc, amount: 25000, bank: 'x', at: prevStart + 1000 });   // mes pasado, antes del corte

  const body = (await get(`/libreta/${o}`)).json();
  assert.equal(body.month.total, 40000);
  assert.equal(body.month.count, 1);
  assert.equal(body.month.startAt, monthStart);
  assert.equal(body.prevMonthToDate.total, 25000, 'el pago temprano del mes pasado SÍ cuenta');

  // Un pago del mes pasado DESPUÉS del punto equivalente NO cuenta en la comparativa
  // (solo verificable si ese instante sigue cayendo dentro del mes pasado).
  const fueraDeCorte = prevStart + (now - monthStart) + 3600_000;
  if (fueraDeCorte < monthStart) {
    s.recordPayment({ accountId: acc, amount: 99000, bank: 'x', at: fueraDeCorte });
    const b2 = (await get(`/libreta/${o}`)).json();
    assert.equal(b2.prevMonthToDate.total, 25000, 'lo del mes pasado más allá del corte no compara');
    assert.equal(b2.month.total, 40000, 'y tampoco se cuela en el mes actual');
  }

  // El feed en vivo también trae month (una venta nueva no deja la tarjeta vieja).
  const feed = (await get(`/libreta/${o}/feed?after=0`)).json();
  assert.equal(feed.month.total, 40000);
  assert.equal(feed.month.startAt, monthStart);
});

// ── Cuenta (Sonós, plan, cuotas) ─────────────────────────────────────────────

test('cuenta con plan cuotas: próxima cuota con monto del scheduler, fecha y estado', async () => {
  const acc = mkCuenta();
  const o = s.createOrder({ amountCents: 8_100_000 }); // 1ª cuota $81.000 (69k + envío 12k)
  const proximaAt = Date.now() + 30 * 24 * 3600 * 1000;
  s.updateOrder(o, {
    status: 'paid', business_name: 'Cuotas SAS', account_id: acc,
    plan: 'cuotas', installments_total: 3, installments_paid: 1,
    installment_next_at: proximaAt, installments_state: 'al_dia',
    next_charge_at: Date.now() + 300 * 24 * 3600 * 1000,
    card_token: 'tok-secreto-no-fugar',
  });

  const body = (await get(`/libreta/${o}`)).json();
  assert.equal(body.cuenta.plan, 'cuotas');
  assert.equal(body.cuenta.cuotas.length, 1);
  // monto = $69.000 PLANOS aunque el checkout haya sido $81.000 (envío solo en la 1ª)
  assert.deepEqual(body.cuenta.cuotas[0], {
    n: 2, pagadas: 1, total: 3, monto: 69000, proximaAt, auto: true, estado: 'al_dia',
  });
  assert.equal(typeof body.cuenta.nextChargeAt, 'number');

  // Orden COD sin marcar (installments_paid=0, sin fecha del scheduler, sin token):
  // la próxima real es la 2ª y la fecha es la teórica del plan (orden + 30d).
  const cod = s.createOrder({ amountCents: 8_600_000 });
  s.updateOrder(cod, {
    status: 'paid', account_id: acc, plan: 'cuotas',
    installments_total: 3, installments_paid: 0,
  });
  const codRow = raw.prepare('SELECT created_at FROM orders WHERE id = ?').get(cod);
  const bodyCod = (await get(`/libreta/${o}`)).json();
  const cuotaCod = bodyCod.cuenta.cuotas.find((c) => c.pagadas === 0);
  assert.deepEqual(cuotaCod, {
    n: 2, pagadas: 0, total: 3, monto: 69000, // NUNCA los $86.000 del checkout COD
    proximaAt: codRow.created_at + 30 * 24 * 3600 * 1000,
    auto: false, estado: 'al_dia',
  });
  s.updateOrder(cod, { installments_state: 'completado' }); // no ensuciar lo que sigue
  // El token de la tarjeta JAMÁS puede viajar a La Libreta.
  const raw2 = JSON.stringify(body);
  assert.ok(!raw2.includes('tok-secreto'), 'card_token no debe fugarse');
  assert.ok(!raw2.includes('card_token'), 'ni siquiera el nombre del campo');

  // Plan completado → desaparece de cuotas pendientes.
  s.updateOrder(o, { installments_paid: 3, installment_next_at: null, installments_state: 'completado' });
  const body2 = (await get(`/libreta/${o}`)).json();
  assert.deepEqual(body2.cuenta.cuotas, []);
});

// ── Filtro por fecha (?day=) ─────────────────────────────────────────────────

// Epoch ms de una hora local Bogotá (UTC-5 fijo).
const bog = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h + 5, mi);

test('feed day: solo las ventas de ese día Bogotá, con cierre {total,count} y shape exacto', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  // Bordes del día Bogotá: 30-jun 23:59 y 2-jul 00:10 NO son del 1-jul.
  s.recordPayment({ accountId: acc, amount: 1000, bank: 'nequi', at: bog(2026, 6, 30, 23, 59) });
  s.recordPayment({ accountId: acc, amount: 2000, bank: 'bancolombia', at: bog(2026, 7, 1, 0, 0) });
  s.recordPayment({ accountId: acc, amount: 3000, bank: 'nequi', at: bog(2026, 7, 1, 23, 59) });
  s.recordPayment({ accountId: acc, amount: 4000, bank: 'daviplata', at: bog(2026, 7, 2, 0, 10) });

  const r = await get(`/libreta/${o}/feed?day=2026-07-01`);
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.deepEqual(Object.keys(body).sort(), ['day', 'dayTotal', 'nextBefore', 'now', 'ok', 'payments']);
  assert.equal(body.day, '2026-07-01');
  assert.deepEqual(body.dayTotal, { total: 5000, count: 2, startAt: bog(2026, 7, 1) });
  assert.deepEqual(body.payments.map((p) => p.amount), [3000, 2000], 'más recientes primero, solo el 1-jul');
  assert.equal(body.nextBefore, null, 'página corta = día completo en una página');
  // Whitelist: mismas keys de libRow (nada de infra ni PII).
  assert.deepEqual(Object.keys(body.payments[0]).sort(), ['amount', 'at', 'bank', 'id', 'key', 'local', 'unrouted']);

  const vacio = (await get(`/libreta/${o}/feed?day=2026-07-03`)).json();
  assert.deepEqual(vacio.payments, []);
  assert.deepEqual(vacio.dayTotal, { total: 0, count: 0, startAt: bog(2026, 7, 3) });
});

test('feed day pagina dentro del día con &before= y el cierre no cambia entre páginas', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  for (let i = 1; i <= 60; i++) {
    s.recordPayment({ accountId: acc, amount: 100 + i, bank: 'x', at: bog(2026, 7, 5, 8, 0) + i * 1000 });
  }
  s.recordPayment({ accountId: acc, amount: 999, bank: 'x', at: bog(2026, 7, 6, 9, 0) }); // otro día: no cuela

  const p1 = (await get(`/libreta/${o}/feed?day=2026-07-05`)).json();
  assert.equal(p1.payments.length, 50);
  assert.equal(p1.dayTotal.count, 60, 'el cierre es del día ENTERO, no de la página');
  assert.ok(p1.nextBefore, 'hay segunda página');

  const p2 = (await get(`/libreta/${o}/feed?day=2026-07-05&before=${p1.nextBefore}`)).json();
  assert.equal(p2.payments.length, 10);
  assert.equal(p2.nextBefore, null);
  assert.equal(p2.dayTotal.count, 60);
  const ids = new Set([...p1.payments, ...p2.payments].map((p) => p.id));
  assert.equal(ids.size, 60, 'sin solapes ni faltantes entre páginas');
  assert.ok(![...p1.payments, ...p2.payments].some((p) => p.amount === 999), 'el pago de otro día no aparece');
});

test('feed day malformado o inexistente → 404 uniforme (mismo body del resto)', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  for (const malo of ['2026-02-31', '2026-13-01', 'ayer', '01-07-2026', '']) {
    const r = await get(`/libreta/${o}/feed?day=${encodeURIComponent(malo)}`);
    assert.equal(r.statusCode, 404, `day="${malo}" debe dar 404`);
    assert.deepEqual(r.json(), { error: 'no encontrada' });
  }
});

// ── Acceso a mi Libreta (reenvío del enlace por WhatsApp) ────────────────────

const postAcceso = (phone) => app.inject({
  method: 'POST', url: '/libreta-acceso',
  headers: { 'content-type': 'application/json' },
  payload: { phone },
});

test('libreta-acceso: teléfono con orden pagada → encola WhatsApp kind libreta con el link', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc, businessName: 'Acceso SAS' });
  s.updateOrder(o, { phone: '300 111 2233' });

  const r = await postAcceso('3001112233');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true });

  const fila = raw.prepare("SELECT * FROM wa_outbox WHERE order_id = ? AND kind = 'libreta'").get(o);
  assert.ok(fila, 'debe quedar encolado el WhatsApp');
  assert.equal(fila.phone, '573001112233');
  assert.ok(fila.body.includes(`/libreta/?order=${o}`), 'el body lleva el link de la Libreta');
});

test('libreta-acceso: teléfono desconocido o de orden archivada → mismo ok:true y NO encola', async () => {
  const antes = raw.prepare('SELECT COUNT(*) AS n FROM wa_outbox').get().n;

  const r1 = await postAcceso('3009998877'); // nadie tiene este número
  assert.equal(r1.statusCode, 200);
  assert.deepEqual(r1.json(), { ok: true }, 'sin match responde IGUAL (sin oráculo)');

  const archivada = mkOrdenPagada({ businessName: 'Archivada SAS' });
  s.updateOrder(archivada, { phone: '3007776655', prev_status: 'paid', status: 'archivada', archived_at: Date.now() });
  const r2 = await postAcceso('3007776655');
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.json(), { ok: true });

  const despues = raw.prepare('SELECT COUNT(*) AS n FROM wa_outbox').get().n;
  assert.equal(despues, antes, 'ni el desconocido ni la archivada encolan nada');
});

// ── Cache ─────────────────────────────────────────────────────────────────────

test('no-store siempre: 200 (resumen y feed) y 404', async () => {
  const acc = mkCuenta();
  const o = mkOrdenPagada({ accountId: acc });
  const r200 = await get(`/libreta/${o}`);
  assert.equal(r200.statusCode, 200);
  assert.equal(r200.headers['cache-control'], 'no-store');
  const rFeed = await get(`/libreta/${o}/feed?after=0`);
  assert.equal(rFeed.headers['cache-control'], 'no-store');
  const r404 = await get(`/libreta/${hexId()}`);
  assert.equal(r404.statusCode, 404);
  assert.equal(r404.headers['cache-control'], 'no-store');
});

// ── Anti-scan (SIEMPRE de último: envenena la IP 127.0.0.1 por 5 min) ─────────

test('anti-scan: acumular 30 404s desde la misma IP → 429 sostenido', async () => {
  // Los tests anteriores ya sumaron algunos 404 al contador de la IP; acá se
  // completa el cupo con ids inventados y se verifica que el guard cierra.
  const resps = [];
  for (let i = 0; i < 31; i++) resps.push(await get(`/libreta/${hexId()}`));
  assert.ok(resps.some((r) => r.statusCode === 404), 'al inicio aún respondía 404');
  const last = resps.at(-1);
  assert.equal(last.statusCode, 429, 'con >=30 fallos en 5 min la IP queda bloqueada');
  assert.deepEqual(last.json(), { error: 'demasiadas solicitudes' });
  assert.equal(last.headers['cache-control'], 'no-store', 'el 429 también va sin caché');
  // Y se mantiene: el siguiente intento sigue bloqueado (los 429 no "desgastan" el contador).
  const otra = await get(`/libreta/${hexId()}`);
  assert.equal(otra.statusCode, 429);
});

// ── Egresos unrouted ─────────────────────────────────────────────────────────
// (Va después del anti-scan porque NO usa GET /libreta: solo webhook + DB raw.)

test('egreso unrouted: "Transferiste" a multipunto con llave sin match → NO se persiste en payments', async () => {
  const acc = mkCuenta();
  s.setAccountForward(acc, { alias: 'egresoalias', forwardTo: 'dueño2@gmail.com' });
  // 2 devices = multipunto: la llave @nomatch77 no coincide → route.unrouted.
  const o1 = mkOrdenPagada({ accountId: acc, businessName: 'Egresos SAS' });
  const o2 = mkOrdenPagada({ accountId: acc });
  s.createDevice({ spkrId: 'spkr-991', mac: 'EG:AA', model: 'wifi' });
  s.assignDevice('spkr-991', o1);
  s.setDeviceBrebKey('spkr-991', { key: '@egresoa', localName: 'Local A' });
  s.createDevice({ spkrId: 'spkr-992', mac: 'EG:BB', model: 'wifi' });
  s.assignDevice('spkr-992', o2);
  s.setDeviceBrebKey('spkr-992', { key: '@egresob', localName: 'Local B' });

  const anunciosAntes = pagosAnunciados.length;
  const r = await app.inject({
    method: 'POST',
    url: '/webhook/email',
    headers: { 'x-sono-secret': 'testsecret123', 'content-type': 'application/json' },
    payload: {
      alias: 'egresoalias',
      from: 'alertasynotificaciones@notificacionesbancolombia.com',
      subject: 'Bancolombia te informa Transferencia realizada',
      // direction:'out' (Transferiste) + llave que NO matchea ningún local → unrouted.
      text: 'Bancolombia: Transferiste $80.000 desde tu cuenta *4369 a la llave @nomatch77 el 03/07/2026.',
      messageId: '<egreso-unrouted-1@banco>',
    },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, true);

  // NO suena (unrouted nunca llega al anunciador) y, siendo egreso, TAMPOCO se
  // persiste: plata que SALE no es una venta de La Libreta.
  assert.equal(pagosAnunciados.length, anunciosAntes, 'un egreso unrouted no llega al anunciador');
  const filas = raw.prepare('SELECT COUNT(*) AS n FROM payments WHERE account_id = ?').get(acc);
  assert.equal(filas.n, 0, 'un egreso (direction out) unrouted NO debe crear fila en payments');
});

test.after(() => { app.close(); raw.close(); });
