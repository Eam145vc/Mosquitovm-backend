// Convierte un monto en pesos colombianos a una secuencia de WAV IDs.
//
// ESTRATEGIA HIBRIDA:
//   1. Si el monto coincide con una FRASE LARGA pre-renderizada (ej: $5.000 -> "Recibiste cinco mil pesos")
//      usamos esa sola frase (100% natural).
//   2. Si no, concatenamos componentes (numeros + magnitudes + pesos).
//
// Manifest v5:
//   037-254: audios de sistema (no usar para anuncios)
//   100-111: frases largas pre-renderizadas
//   000-091: componentes para concatenado

// ---------------------------------------------------------------------------
// FRASES LARGAS pre-renderizadas (mapeo monto -> ID que incluye "Recibiste X pesos")
// ---------------------------------------------------------------------------
const FRASES_LARGAS = {
  1000: '100',     // Recibiste mil pesos
  2000: '101',     // Recibiste dos mil pesos
  3000: '102',     // Recibiste tres mil pesos
  5000: '103',     // Recibiste cinco mil pesos
  10000: '104',    // Recibiste diez mil pesos
  20000: '105',    // Recibiste veinte mil pesos
  30000: '106',    // Recibiste treinta mil pesos
  50000: '107',    // Recibiste cincuenta mil pesos
  100000: '108',   // Recibiste cien mil pesos
  200000: '109',   // Recibiste doscientos mil pesos
  500000: '110',   // Recibiste quinientos mil pesos
  1000000: '111',  // Recibiste un millon de pesos
};

// ---------------------------------------------------------------------------
// COMPONENTES para concatenado
// ---------------------------------------------------------------------------
const NUM = {
  0: '000', 1: '001', 2: '002', 3: '003', 4: '004', 5: '005',
  6: '006', 7: '007', 8: '008', 9: '009', 10: '010', 11: '011',
  12: '012', 13: '013', 14: '014', 15: '015', 16: '016', 17: '017',
  18: '018', 19: '019', 20: '020', 21: '021', 22: '022', 23: '023',
  24: '024', 25: '025', 26: '026', 27: '027', 28: '028', 29: '029',
  30: '030',
  40: '043', 50: '044', 60: '045', 70: '046', 80: '047', 90: '048',
};
const TREINTA_Y = '031';
const CIEN = '049';
const CIENTO = '050';
const CENTENAS = {
  200: '051', 300: '052', 400: '053', 500: '054',
  600: '056', 700: '057', 800: '058', 900: '059',
};
const MIL = '060';
const UN_MILLON = '061';
const MILLONES = '062';
const Y = '063';
const PESOS = '064';
const PESO = '065';

const EARCON = '076';   // sonido (din-don) que abre cada anuncio
const CONFIRMADO = '075'; // voz "pago confirmado": cierra cada anuncio
const RECIBISTE = '070';
const TRANSFERISTE = '071'; // "Transferiste" (egresos) — WAV PENDIENTE de generar y flashear
const DE = '073';

const BANCOS = {
  bancolombia: '080',
  nequi: '081',
  daviplata: '082',
  davivienda: '083',
  bbva: '084',
  bogota: '085',     // Banco de Bogota
  pse: '089',
  movii: '090',
};

// ---------------------------------------------------------------------------
// Conversores
// ---------------------------------------------------------------------------

/** Numero 0-99 -> array de IDs WAV en espanol */
function numToWavs99(n) {
  if (n < 0 || n > 99) throw new Error(`numToWavs99: ${n} fuera de rango`);
  if (n in NUM) return [NUM[n]];           // 0-29, 30, 40, 50, 60, 70, 80, 90
  if (n < 40) return [TREINTA_Y, NUM[n - 30]]; // 31-39 -> "treinta y X"
  // 40-99: si n%10 == 0 ya esta en NUM (lo cubrio arriba)
  const decena = Math.floor(n / 10) * 10;
  const unidad = n % 10;
  return [NUM[decena], Y, NUM[unidad]];
}

/** Numero 0-999 -> array de IDs WAV en espanol */
function numToWavs999(n) {
  if (n < 0 || n > 999) throw new Error(`numToWavs999: ${n} fuera de rango`);
  if (n === 0) return [NUM[0]];
  if (n < 100) return numToWavs99(n);
  if (n === 100) return [CIEN];
  if (n < 200) return [CIENTO, ...numToWavs99(n - 100)];
  const c = Math.floor(n / 100) * 100;
  const resto = n % 100;
  if (resto === 0) return [CENTENAS[c]];
  return [CENTENAS[c], ...numToWavs99(resto)];
}

/** Solo el numero como cadena de WAVs (sin "Recibiste" ni "pesos"). */
export function amountToWavs(amount) {
  amount = Math.floor(Math.abs(Number(amount)));
  if (Number.isNaN(amount)) throw new Error('amount no es numero');
  if (amount === 0) return [NUM[0]];

  const out = [];
  const millones = Math.floor(amount / 1_000_000);
  const miles = Math.floor((amount % 1_000_000) / 1000);
  const resto = amount % 1000;

  if (millones > 0) {
    if (millones === 1) {
      out.push(UN_MILLON);                       // "un millon"
    } else {
      out.push(...numToWavs999(millones), MILLONES); // "X millones"
    }
  }

  if (miles > 0) {
    if (miles === 1) {
      out.push(MIL);                              // "mil" sin "uno"
    } else {
      out.push(...numToWavs999(miles), MIL);      // "X mil"
    }
  }

  if (resto > 0) {
    out.push(...numToWavs999(resto));
  }

  return out;
}

/**
 * Devuelve la secuencia de WAVs para anunciar un pago.
 * Usa frase larga si existe; sino, concatenado completo.
 *
 * @param {Object} opts
 * @param {number} opts.amount
 * @param {string} [opts.bank]      - clave en BANCOS (bancolombia, nequi, ...)
 * @param {boolean} [opts.includeBank=true]
 * @param {string} [opts.direction='in'] - 'in' (pago recibido) | 'out' (egreso)
 * @returns {string}                - "070-005-060-064-073-080"
 */
export function buildVoiceMessage({ amount, bank, includeBank = true, direction = 'in' }) {
  amount = Math.floor(Math.abs(Number(amount)));

  // EGRESO: "Transferiste <numero> pesos". SIN earcon ni "pago confirmado":
  // esos dos son la marca sonora de plata que ENTRA, no deben confundirse.
  if (direction === 'out') {
    return [TRANSFERISTE, ...amountToWavs(amount), amount === 1 ? PESO : PESOS].join('-');
  }

  // EARCON primero SIEMPRE: el comerciante asocia ese sonido a "pago confirmado".
  const parts = [EARCON];

  // Camino A: frase larga pre-renderizada exacta
  if (FRASES_LARGAS[amount]) {
    parts.push(FRASES_LARGAS[amount]);
  } else {
    // Camino B: concatenado "Recibiste <numero> peso(s)"
    parts.push(RECIBISTE);
    parts.push(...amountToWavs(amount));
    parts.push(amount === 1 ? PESO : PESOS);
  }

  if (includeBank && bank && BANCOS[bank]) {
    parts.push(DE);
    parts.push(BANCOS[bank]);
  }

  // "Pago confirmado" SIEMPRE al final del anuncio.
  parts.push(CONFIRMADO);

  return parts.join('-');
}

/**
 * Indica si el monto va a sonar "perfecto" (frase larga) o "concatenado".
 * Util para el panel admin para mostrar estadisticas de calidad de voz.
 */
export function speechQuality(amount) {
  amount = Math.floor(Math.abs(Number(amount)));
  return FRASES_LARGAS[amount] ? 'natural' : 'concatenated';
}

export { BANCOS, FRASES_LARGAS };
