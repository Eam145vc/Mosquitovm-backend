// Decodificador de QR Bre-B (EMVCo) para Sonó multipunto.
//
// El QR que el cliente sube trae, en formato EMVCo TLV, la LLAVE Bre-B del local
// (tag 26, namespace CO.COM.RBM.LLA). Extraemos esa llave para rutear los pagos al
// speaker correcto, y guardamos el string EMVCo crudo para poder regenerar el QR
// de impresión.
//
// Verificado con 2 QR reales (jun-2026):
//   - llave alfanumérica:  tag 26.04 = "@jhon437203"
//   - por cuenta/numérica: tag 26.05 = "353497" + cuenta en tag 50.01 = "0029353497"
//
// Tipos de llave Bre-B: alfanumérica (@texto), celular, cédula, correo (Banrep). En el
// QR alfanumérico viene el @texto directo; en los otros formatos usamos la cuenta como
// identificador estable del local.

import { Jimp } from 'jimp';
import jsQR from 'jsqr';

// Tags EMVCo que son "templates" (contienen sub-TLV). 02-51 = merchant account info,
// 62/64 = additional data, 80-99 = namespaces propietarios de Bre-B.
const TEMPLATE_TAGS = new Set();
for (let i = 2; i <= 51; i++) TEMPLATE_TAGS.add(String(i).padStart(2, '0'));
['62', '64', '65', '80', '81', '82', '83', '84', '85', '99'].forEach((t) => TEMPLATE_TAGS.add(t));

/**
 * Parsea un string EMVCo (TLV) a un objeto. Cada campo: tag(2) + length(2) + value.
 * Los tags-template se anidan en `.children`. Devuelve {} si el string no es TLV válido.
 * Ej: { "00": "01", "26": { children: { "00": "CO.COM.RBM.LLA", "04": "@jhon437203" } } }
 */
export function parseEmvco(s, depth = 0) {
  const out = {};
  if (typeof s !== 'string') return out;
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = parseInt(s.slice(i + 2, i + 4), 10);
    if (Number.isNaN(len) || i + 4 + len > s.length) break;
    const val = s.slice(i + 4, i + 4 + len);
    if (TEMPLATE_TAGS.has(tag) && depth < 3 && /^[\x20-\x7e]+$/.test(val)) {
      const children = parseEmvco(val, depth + 1);
      out[tag] = Object.keys(children).length ? { val, children } : val;
    } else {
      out[tag] = val;
    }
    i += 4 + len;
  }
  return out;
}

// Normaliza una llave para comparar (minúsculas, sin espacios). El @ se conserva.
export function normalizeKey(k) {
  return String(k || '').trim().toLowerCase();
}

/**
 * Extrae la llave Bre-B de un string EMVCo. Devuelve null si no hay tag 26.
 *
 * El RUTEO multipunto es SOLO por llave `@` (alfanumérica): es lo único que distingue
 * locales dentro de una misma cuenta bancaria. Si el QR no trae `@` (es por cuenta),
 * `routable` es false → ese local NO se podrá rutear (cae en "no suena + aviso") hasta
 * que el cliente registre una llave Bre-B.
 *
 * Las llaves Bre-B son de 4 tipos (alfanumérica @, celular, cédula, NÚMERO de llave). TODAS
 * son únicas por local y TODAS rutean. Confirmado con QR reales de Bancolombia:
 *   - "Llave: @jhon437203"  → tag 26.04 = "@jhon437203"  (alfanumérica)
 *   - "Llave: 0029353497"   → tag 26.05 + cuenta 50.01 = "0029353497"  (llave numérica;
 *                             Bancolombia la rotula "Llave", NO es la cuenta de ruteo)
 *
 * Por eso ambos casos son `routable: true`. La llave numérica se toma del valor del tag
 * 26 (o de la cuenta 50.01, que es el mismo número que el banco muestra como "Llave").
 *
 * @returns {{key: string, keyType: 'alias'|'numerica', account, merchantName, routable: boolean}|null}
 *   key: la llave normalizada para el ruteo. null solo si el QR no trae ningún identificador.
 */
export function extractBrebKey(emvco) {
  const tlv = parseEmvco(emvco);

  // Un subtag puede venir como string o como template anidado {val,children}: tomar
  // siempre el valor crudo. Sin esto, normalizeKey de un objeto producía
  // "[object object]" guardado como llave (caso spkr-012).
  const rawVal = (x) => (typeof x === 'string' ? x : (x && x.val) || null);

  // Los namespaces Bre-B (subtag 00 = "CO.COM.RBM.XXX") NO van siempre en el mismo tag:
  // el formato clásico de Bancolombia trae la llave en tag 26 (LLA) y la cuenta en 50 (CU),
  // pero hay una variante nueva (vista jul-2026, orden 434c25cd "Como en Casa") SIN tag 26,
  // con la llave en tag 50 namespace CU. Por eso se busca cada namespace por contenido en
  // todos los templates de primer nivel, no por número de tag.
  const findNs = (ns) => {
    for (const t of Object.values(tlv)) {
      if (t && t.children && rawVal(t.children['00']) === ns) return t.children;
    }
    return null;
  };

  const c = findNs('CO.COM.RBM.LLA');
  const cu = findNs('CO.COM.RBM.CU');
  const account = cu ? rawVal(cu['01']) : null;
  const merchantName = (typeof tlv['59'] === 'string' ? tlv['59'] : null);

  // Variante sin template LLA: la llave es el número del namespace CU (coincide con lo
  // que Bancolombia imprime como "Llave: NNNN" bajo el QR).
  if (!c) {
    if (account) {
      return { key: normalizeKey(account), keyType: 'numerica', account, merchantName, routable: true };
    }
    return null;
  }

  // El tipo de llave Bre-B va en el SUBTAG del template LLA (verificado con QR reales):
  //   .01 = correo · .02 = celular · .03 = cédula · .04 = alfanumérica @ ·
  //   .05 = numérica (en este caso la llave es el nº de cuenta, namespace CU).
  // Las 4 son LLAVES únicas por local → todas rutean. Tomamos el primer subtag con valor
  // (saltando 00, que es el namespace "CO.COM.RBM.LLA").
  for (const sub of ['04', '02', '03', '01']) {
    const v = rawVal(c[sub]);
    if (!v) continue;
    const keyType = /@/.test(v) ? 'alias' : 'numerica';
    return { key: normalizeKey(v), keyType, account, merchantName, routable: true };
  }
  // LLA.05 = llave NUMÉRICA cuyo valor es el nº de cuenta (Bancolombia lo muestra como
  // "Llave: 0029353497"). Es una LLAVE, sí rutea.
  if (c['05'] && account) {
    return { key: normalizeKey(account), keyType: 'numerica', account, merchantName, routable: true };
  }
  // Último recurso: cualquier otro subtag del template LLA (distinto de 00) con valor.
  for (const k of Object.keys(c)) {
    if (k !== '00' && c[k] && typeof c[k] === 'string') {
      return { key: normalizeKey(c[k]), keyType: /@/.test(c[k]) ? 'alias' : 'numerica', account, merchantName, routable: true };
    }
  }
  return null;
}

/**
 * Decodifica un string EMVCo a un objeto listo para guardar/rutear. Devuelve null si
 * el string no es un QR Bre-B válido (sin llave).
 * @returns {{key, keyType, account, merchantName, raw, tlv}|null}
 */
export function decodeBrebString(emvco) {
  const k = extractBrebKey(emvco);
  if (!k) return null;
  return { ...k, raw: emvco, tlv: parseEmvco(emvco) };
}

/**
 * Lee el QR de una imagen (buffer PNG/JPG), obtiene el string EMVCo y lo decodifica.
 * Devuelve null si no se pudo leer el QR o no es un Bre-B válido.
 * @param {Buffer} imageBuffer
 */
export async function decodeBrebImage(imageBuffer) {
  let base;
  try {
    base = await Jimp.read(imageBuffer);
  } catch {
    return null;
  }
  // jsQR es sensible a la resolución y el contraste: el template oficial de
  // Bancolombia (880px, QR con logo al centro) fallaba tal cual pero decodifica
  // reescalado (visto jul-2026, orden de Vera Sáenz). Intentos en cascada; el
  // primero que decodifique un Bre-B válido gana.
  const attempts = [
    () => base,
    () => base.clone().greyscale().contrast(0.5),
    () => base.clone().resize({ w: 1600 }),
    () => base.clone().resize({ w: 900 }),
    () => base.clone().resize({ w: 600 }),
    () => base.clone().resize({ w: 400 }),
  ];
  for (const make of attempts) {
    try {
      const { data, width, height } = make().bitmap;
      const code = jsQR(new Uint8ClampedArray(data), width, height);
      if (code && code.data) {
        const decoded = decodeBrebString(code.data);
        if (decoded) return decoded;
      }
    } catch { /* siguiente intento */ }
  }
  return null;
}
