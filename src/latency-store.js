// Acumulador de latencias del pipeline de pago (para el panel admin).
//
// Guarda las últimas N mediciones en memoria + un agregado por cuenta que
// sobrevive (count, sumas, máximos) para promedios. Persiste a disco best-effort
// para no perder el histórico en reinicios.
//
// Tramos medidos (ver latency.js):
//   bankToBackendMs  A→C  banco emite + viaje + ForwardEmail (caja negra del banco)
//   feToBackendMs    B→C  ForwardEmail → backend
//   backendToVoiceMs C→D  parser + MQTT (lo nuestro)

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { recordBankSample } from './bank-status.js';

const FILE = path.join(path.dirname(config.DB_PATH), 'latency.json');
const MAX_SAMPLES = 5000; // detalle histórico (para filtrar por fecha y ver "todo el registro")

// samples: [{ at, accountId, amount, bank, bankToBackendMs, feToBackendMs, backendToVoiceMs }]
let samples = [];
// agg por cuenta: { n, sumBank, sumFe, sumUs, maxBank, maxFe, maxUs, lastAt }
const agg = new Map();

function blankAgg() {
  return { n: 0, sumBank: 0, nBank: 0, sumFe: 0, nFe: 0, sumUs: 0, nUs: 0, maxBank: 0, maxFe: 0, maxUs: 0, lastAt: 0 };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    samples = Array.isArray(raw.samples) ? raw.samples.slice(-MAX_SAMPLES) : [];
    if (raw.agg) for (const [k, v] of Object.entries(raw.agg)) agg.set(k, v);
  } catch { /* primer arranque, sin archivo */ }
}
load();

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(FILE, JSON.stringify({ samples, agg: Object.fromEntries(agg) }));
    } catch (e) { logger.warn({ err: e.message }, 'latency-store: no se pudo guardar'); }
  }, 2000);
}

/** Registra una medición ya cerrada (la línea que arma markVoicePublished). */
export function recordLatency(line) {
  if (!line) return;
  const at = Date.now();
  const s = {
    at,
    accountId: line.accountId || null,
    amount: line.amount ?? null,
    bank: line.bank || 'unknown',
    brebKey: line.brebKey || null,   // llave Bre-B del pago (para ruteo/identificación)
    alias: line.alias || null,       // alias @sono.lat al que llegó el correo
    account: line.account || null,   // últimos dígitos de la cuenta destino
    bankToBackendMs: line.bankToBackendMs ?? null,  // demora del pago hasta el MX (única confiable)
    feToBackendMs: line.feToBackendMs ?? null,
    backendToVoiceMs: line.backendToVoiceMs ?? null,
    precise: line.precise ?? false,                 // true = medido con segundos; false = ±60s
    paidAt: line.paidAt ?? null,                    // diagnóstico: hora del pago (cuerpo)
    headerDate: line.headerDate ?? null,            // diagnóstico: header Date (con segundos)
  };
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.shift();

  // Alimenta el detector de demoras por banco (auto-aviso a los speakers afectados).
  try {
    recordBankSample({ bank: s.bank, bankToBackendMs: s.bankToBackendMs, precise: s.precise });
  } catch (e) {
    logger.warn({ err: e.message }, 'bank-status: no se pudo registrar la muestra');
  }

  const key = s.accountId || 'unknown';
  const a = agg.get(key) || blankAgg();
  a.n += 1;
  a.lastAt = at;
  if (s.bankToBackendMs != null) { a.sumBank += s.bankToBackendMs; a.nBank += 1; a.maxBank = Math.max(a.maxBank, s.bankToBackendMs); }
  if (s.feToBackendMs != null)   { a.sumFe += s.feToBackendMs;     a.nFe += 1;   a.maxFe = Math.max(a.maxFe, s.feToBackendMs); }
  if (s.backendToVoiceMs != null){ a.sumUs += s.backendToVoiceMs;  a.nUs += 1;   a.maxUs = Math.max(a.maxUs, s.backendToVoiceMs); }
  agg.set(key, a);
  saveSoon();
}

const avg = (sum, n) => (n > 0 ? Math.round(sum / n) : null);

/** p95 de un campo sobre las muestras dadas (simple, para volúmenes chicos). */
function p95(arr) {
  const xs = arr.filter((x) => x != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];
}

/**
 * Estadísticas para el panel admin.
 * resolveName(accountId) → string opcional para mostrar el nombre del comercio.
 * opts: { from, to, all } — rango de fecha (epoch ms) y si devolver TODO el detalle.
 */
export function getStats(resolveName, opts = {}) {
  const { from = null, to = null, all = false } = opts;
  const inRange = (s) => (from == null || s.at >= from) && (to == null || s.at <= to);
  const hasRange = from != null || to != null;
  // Ventana de análisis: con rango, TODAS las estadísticas (global, por banco y por
  // comercio) se calculan SOLO sobre ese rango. Sin rango, sobre el histórico en
  // memoria (últimas MAX_SAMPLES). Antes el rango solo filtraba el detalle y las
  // tarjetas siempre mostraban el histórico completo — engañoso.
  const win = hasRange ? samples.filter(inRange) : samples;

  // Global: promedios y p95 sobre la ventana.
  const global = {
    n: win.length,
    avgBankMs: avg(win.reduce((s, x) => s + (x.bankToBackendMs || 0), 0), win.filter((x) => x.bankToBackendMs != null).length),
    avgFeMs: avg(win.reduce((s, x) => s + (x.feToBackendMs || 0), 0), win.filter((x) => x.feToBackendMs != null).length),
    avgUsMs: avg(win.reduce((s, x) => s + (x.backendToVoiceMs || 0), 0), win.filter((x) => x.backendToVoiceMs != null).length),
    p95BankMs: p95(win.map((x) => x.bankToBackendMs)),
    p95FeMs: p95(win.map((x) => x.feToBackendMs)),
    p95UsMs: p95(win.map((x) => x.backendToVoiceMs)),
  };
  global.avgTotalMs = global.avgBankMs != null ? global.avgBankMs + (global.avgUsMs || 0) : null;

  // Bancos vistos por comercio en la ventana (para mostrar logos en el panel).
  // El agg histórico no guarda banco, así que esto sale SIEMPRE de las muestras.
  const banksByAcc = new Map();
  for (const s of win) {
    const k = s.accountId || 'unknown';
    const m = banksByAcc.get(k) || new Map();
    const b = s.bank || 'unknown';
    m.set(b, (m.get(b) || 0) + 1);
    banksByAcc.set(k, m);
  }

  const mapClient = ([accountId, a]) => ({
    accountId,
    name: (resolveName && accountId !== 'unknown' && resolveName(accountId)) || null,
    n: a.n,
    avgBankMs: avg(a.sumBank, a.nBank),
    avgFeMs: avg(a.sumFe, a.nFe),
    avgUsMs: avg(a.sumUs, a.nUs),
    maxBankMs: a.maxBank || null,
    lastAt: a.lastAt || null,
    banks: [...(banksByAcc.get(accountId)?.entries() || [])]
      .map(([bank, n]) => ({ bank, n }))
      .sort((x, y) => y.n - x.n),
  });

  // Por comercio: con rango se agrega sobre la ventana; sin rango, el agg histórico
  // (que sobrevive aunque samples esté capado).
  let clientEntries;
  if (hasRange) {
    const byAcc = new Map();
    for (const s of win) {
      const k = s.accountId || 'unknown';
      const a = byAcc.get(k) || blankAgg();
      a.n += 1;
      a.lastAt = Math.max(a.lastAt, s.at);
      if (s.bankToBackendMs != null) { a.sumBank += s.bankToBackendMs; a.nBank += 1; a.maxBank = Math.max(a.maxBank, s.bankToBackendMs); }
      if (s.feToBackendMs != null)   { a.sumFe += s.feToBackendMs;     a.nFe += 1; }
      if (s.backendToVoiceMs != null){ a.sumUs += s.backendToVoiceMs;  a.nUs += 1; }
      byAcc.set(k, a);
    }
    clientEntries = [...byAcc.entries()];
  } else {
    clientEntries = [...agg.entries()];
  }
  const perClient = clientEntries.map(mapClient).sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0));

  // Por BANCO: cada entidad (bancolombia, nequi, daviplata...) tiene latencia muy
  // distinta (Nequi ~1s, Bancolombia ~5s). Promediarlas juntas engaña; las separamos.
  const byBank = {};
  for (const s of win) {
    const b = s.bank || 'unknown';
    if (!byBank[b]) byBank[b] = { bank: b, n: 0, sumBank: 0, nBank: 0, sumUs: 0, nUs: 0, bankVals: [] };
    const e = byBank[b];
    e.n += 1;
    if (s.bankToBackendMs != null) { e.sumBank += s.bankToBackendMs; e.nBank += 1; e.bankVals.push(s.bankToBackendMs); }
    if (s.backendToVoiceMs != null) { e.sumUs += s.backendToVoiceMs; e.nUs += 1; }
  }
  const perBank = Object.values(byBank).map((e) => ({
    bank: e.bank,
    n: e.n,
    avgBankMs: avg(e.sumBank, e.nBank),   // banco→Sonó (la latencia propia de esa entidad)
    p95BankMs: p95(e.bankVals),
    avgUsMs: avg(e.sumUs, e.nUs),
  })).sort((x, y) => y.n - x.n);

  // Detalle: por defecto las últimas 50; con rango o all=1 se devuelve toda la ventana
  // (más nuevas primero).
  let picked = hasRange || all ? win : win.slice(-50);
  // Tope de seguridad para no devolver un payload gigante al panel.
  const RECENT_CAP = 1000;
  const recent = picked.slice(-RECENT_CAP).reverse().map((s) => ({
    ...s,
    name: (resolveName && s.accountId && resolveName(s.accountId)) || null,
  }));

  return { global, perBank, perClient, recent, recentTotal: picked.length };
}
