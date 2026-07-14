// Detector de demoras por banco + auto-disparador del aviso de demora.
//
// Se alimenta de las mediciones de latencia (latency-store.recordLatency): cada pago
// trae cuánto tardó el banco en EMITIR el aviso (bankToBackendMs). Cuando un banco
// acumula varios pagos lentos en poco tiempo, se dispara UNA vez el aviso hablado
// (audio 120: "las notificaciones pueden tardar más de lo normal por demoras del
// banco") SOLO en los speakers de los clientes que reciben pagos de ESE banco.
//
// Histéresis anti-falsas-alarmas (decisión del usuario: que NO sea sensible — un
// pago puede demorar y al ratico estar bien):
//  - "lento" = bankToBackendMs ≥ 180s si la medición es precisa; ≥240s si es
//    imprecisa (±60s, ej. Bancolombia medida por header adyacente).
//  - DISPARA: ≥3 pagos lentos en 15 min Y que sean mayoría de los pagos del banco.
//  - CIERRA: 10 min sin un solo pago lento → incidente terminado.
//  - RE-AVISO: nunca dentro del mismo incidente, y mínimo 1 h entre avisos del
//    mismo banco (si abre-cierra-abre rápido, no bombardea).

import { logger } from './logger.js';

export const SLOW_PRECISE_MS = 180_000;
export const SLOW_IMPRECISE_MS = 240_000;
export const WINDOW_MS = 15 * 60_000;
export const MIN_SLOW = 3;
export const MIN_RATIO = 0.5;
export const CLEAR_MS = 10 * 60_000;
export const MIN_GAP_MS = 60 * 60_000;

// bank → { samples:[{at,slow}], incident, since, lastSlowAt, lastFiredAt }
const banks = new Map();

let onIncidentCb = null;
/** Registra el callback que manda el aviso (lo inyecta index.js, para no acoplar MQTT acá). */
export function onIncident(cb) {
  onIncidentCb = cb;
}

/** Una medición de pago cerrada. `now` inyectable solo para los tests. */
export function recordBankSample({ bank, bankToBackendMs, precise }, now = Date.now()) {
  if (!bank || bank === 'unknown' || bankToBackendMs == null) return;
  const st = banks.get(bank) || { samples: [], incident: false, since: 0, lastSlowAt: 0, lastFiredAt: 0 };
  banks.set(bank, st);

  // Cierre por inactividad: si el incidente quedó abierto pero llevamos CLEAR_MS sin
  // un pago lento, se considera terminado ANTES de procesar la muestra nueva (así un
  // lento aislado horas después no "continúa" el incidente viejo: arranca de cero).
  if (st.incident && now - st.lastSlowAt >= CLEAR_MS) {
    st.incident = false;
    logger.info({ bank, duracionMin: Math.round((st.lastSlowAt - st.since) / 60_000) },
      'demoras del banco: incidente cerrado');
  }

  const slow = bankToBackendMs >= (precise ? SLOW_PRECISE_MS : SLOW_IMPRECISE_MS);
  st.samples.push({ at: now, slow });
  if (slow) st.lastSlowAt = now;
  st.samples = st.samples.filter((s) => now - s.at <= WINDOW_MS);

  if (!st.incident) {
    const slowN = st.samples.filter((s) => s.slow).length;
    if (slowN >= MIN_SLOW && slowN / st.samples.length >= MIN_RATIO) {
      st.incident = true;
      st.since = now;
      logger.warn({ bank, lentos: slowN, total: st.samples.length }, 'demoras del banco: incidente ABIERTO');
      if (now - st.lastFiredAt >= MIN_GAP_MS && onIncidentCb) {
        st.lastFiredAt = now;
        Promise.resolve(onIncidentCb(bank))
          .catch((e) => logger.error({ bank, err: e.message }, 'aviso de demora del banco falló'));
      }
    }
  }
}

/** Estado actual por banco (para el panel admin). El "demorado" expira solo. */
export function snapshot(now = Date.now()) {
  const out = [];
  for (const [bank, st] of banks) {
    const demorado = st.incident && now - st.lastSlowAt < CLEAR_MS;
    out.push({
      bank,
      demorado,
      desde: demorado ? st.since : null,
      ultimoLentoAt: st.lastSlowAt || null,
      ultimoAvisoAt: st.lastFiredAt || null,
    });
  }
  return out;
}

/** Solo para tests: resetea todo el estado. */
export function _reset() {
  banks.clear();
  onIncidentCb = null;
}
