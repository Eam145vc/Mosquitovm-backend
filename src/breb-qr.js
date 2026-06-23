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
 * @returns {{key: string, keyType: 'alias'|'cuenta', account: string|null, merchantName: string|null}|null}
 *   key: la llave NORMALIZADA usada para el ruteo.
 *   keyType: 'alias' si es @texto; 'cuenta' si se identificó por número de cuenta.
 */
export function extractBrebKey(emvco) {
  const tlv = parseEmvco(emvco);
  const t26 = tlv['26'];
  if (!t26 || !t26.children) return null;
  const c = t26.children;

  // Cuenta (tag 50.01) y nombre del comercio (tag 59) si vienen.
  const t50 = tlv['50'];
  const account = (t50 && t50.children && t50.children['01']) || null;
  const merchantName = (typeof tlv['59'] === 'string' ? tlv['59'] : null);

  // Llave alfanumérica: subtag 04 del template 26 (ej "@jhon437203").
  if (c['04'] && /^@/.test(c['04'])) {
    return { key: normalizeKey(c['04']), keyType: 'alias', account, merchantName };
  }
  // Otros formatos (celular/cédula/cuenta): usamos la cuenta como identificador estable.
  if (account) {
    return { key: normalizeKey(account), keyType: 'cuenta', account, merchantName };
  }
  // Último recurso: cualquier subtag de 26 que tenga valor identificable.
  const fallback = c['04'] || c['05'] || (c['05']?.children && c['05'].children['00']);
  if (fallback) {
    return { key: normalizeKey(fallback), keyType: 'cuenta', account, merchantName };
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
  let img;
  try {
    img = await Jimp.read(imageBuffer);
  } catch {
    return null;
  }
  const { data, width, height } = img.bitmap;
  const code = jsQR(new Uint8ClampedArray(data), width, height);
  if (!code || !code.data) return null;
  return decodeBrebString(code.data);
}
