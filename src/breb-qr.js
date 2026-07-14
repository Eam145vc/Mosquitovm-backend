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
  const t26 = tlv['26'];
  if (!t26 || !t26.children) return null;
  const c = t26.children;

  const t50 = tlv['50'];
  // 50.01 puede venir como string o como template anidado {val,children} (igual que los
  // subtags de 26): tomar el valor crudo. Sin esto, la rama de llave numérica hacía
  // normalizeKey de un objeto → "[object object]" guardado como llave (caso spkr-012).
  const t50c = t50 && t50.children ? t50.children['01'] : null;
  const account = typeof t50c === 'string' ? t50c : (t50c && t50c.val) || null;
  const merchantName = (typeof tlv['59'] === 'string' ? tlv['59'] : null);

  // El tipo de llave Bre-B va en el SUBTAG del tag 26 (verificado con QR reales):
  //   26.01 = correo · 26.02 = celular · 26.03 = cédula · 26.04 = alfanumérica @ ·
  //   26.05 = numérica (en este caso la llave es el nº de cuenta, tag 50.01).
  // Las 4 son LLAVES únicas por local → todas rutean. Tomamos el primer subtag con valor
  // (saltando 00, que es el namespace "CO.COM.RBM.LLA").
  for (const sub of ['04', '02', '03', '01']) {
    if (c[sub]) {
      // El subtag puede venir como string ("3203043887") o, si el firmware lo emite como
      // template anidado, como objeto { val, children }. Tomamos el valor crudo en ambos casos
      // (sin esto, normalizeKey de un objeto producía "[object object]" y el ruteo fallaba).
      const v = typeof c[sub] === 'string' ? c[sub] : c[sub].val;
      if (!v) continue;
      const keyType = /@/.test(v) ? 'alias' : 'numerica';
      return { key: normalizeKey(v), keyType, account, merchantName, routable: true };
    }
  }
  // 26.05 = llave NUMÉRICA cuyo valor es el nº de cuenta (Bancolombia lo muestra como
  // "Llave: 0029353497"). Es una LLAVE, sí rutea.
  if (c['05'] && account) {
    return { key: normalizeKey(account), keyType: 'numerica', account, merchantName, routable: true };
  }
  // Último recurso: cualquier otro subtag de 26 (distinto de 00) con valor.
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
