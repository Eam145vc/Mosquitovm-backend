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

const FILE = path.join(path.dirname(config.DB_PATH), 'latency.json');
const MAX_SAMPLES = 500; // detalle reciente

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
    bankToBackendMs: line.bankToBackendMs ?? null,
    feToBackendMs: line.feToBackendMs ?? null,
    backendToVoiceMs: line.backendToVoiceMs ?? null,
  };
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.shift();

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
 */
export function getStats(resolveName) {
  // Global: promedios y p95 sobre las muestras recientes.
  const global = {
    n: samples.length,
    avgBankMs: avg(samples.reduce((s, x) => s + (x.bankToBackendMs || 0), 0), samples.filter((x) => x.bankToBackendMs != null).length),
    avgFeMs: avg(samples.reduce((s, x) => s + (x.feToBackendMs || 0), 0), samples.filter((x) => x.feToBackendMs != null).length),
    avgUsMs: avg(samples.reduce((s, x) => s + (x.backendToVoiceMs || 0), 0), samples.filter((x) => x.backendToVoiceMs != null).length),
    p95BankMs: p95(samples.map((x) => x.bankToBackendMs)),
    p95FeMs: p95(samples.map((x) => x.feToBackendMs)),
    p95UsMs: p95(samples.map((x) => x.backendToVoiceMs)),
  };
  global.avgTotalMs = global.avgBankMs != null ? global.avgBankMs + (global.avgUsMs || 0) : null;

  // Por comercio: promedios históricos del agg.
  const perClient = [...agg.entries()].map(([accountId, a]) => ({
    accountId,
    name: (resolveName && accountId !== 'unknown' && resolveName(accountId)) || null,
    n: a.n,
    avgBankMs: avg(a.sumBank, a.nBank),
    avgFeMs: avg(a.sumFe, a.nFe),
    avgUsMs: avg(a.sumUs, a.nUs),
    maxBankMs: a.maxBank || null,
    lastAt: a.lastAt || null,
  })).sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0));

  // Detalle reciente (últimas 50, más nuevas primero).
  const recent = samples.slice(-50).reverse().map((s) => ({
    ...s,
    name: (resolveName && s.accountId && resolveName(s.accountId)) || null,
  }));

  return { global, perClient, recent };
}
