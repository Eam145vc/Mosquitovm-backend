// Parser generico - solo intenta extraer un monto si todo el texto
// contiene palabras tipicas de "recibo de pago".
// Util como fallback solo cuando el remitente esta en allowlist pero
// ningun parser especifico lo cubrio.
import { parseAmount, hasOutgoingVerb, parseOutgoingAmount } from './parse-amount.js';

export const name = 'generic';

export function parse(text) {
  if (!text) return null;
  const looksLikePayment = /(recib|abono|consignaci|transferencia|pago|enviaron|pagaron|depositaron)/i.test(text);
  if (!looksLikePayment) return null;

  // Egreso con verbo explícito pegado al monto → direction out.
  const outAmount = parseOutgoingAmount(text);
  if (outAmount > 0) {
    return { amount: outAmount, currency: 'COP', bank: 'unknown', direction: 'out', parser: 'generic' };
  }
  // Hay verbo de egreso pero sin monto extraíble: mejor no anunciar nada.
  if (hasOutgoingVerb(text)) return null;

  // Buscar primer monto con $ seguido por numero
  const m = text.match(/\$\s?([\d.,]+)/);
  if (!m) return null;
  const amount = parseAmount(m[1]);
  if (!amount) return null;
  return { amount, currency: 'COP', bank: 'unknown', direction: 'in', parser: 'generic' };
}

export function matches() { return false; }  // generic nunca matches por sender
