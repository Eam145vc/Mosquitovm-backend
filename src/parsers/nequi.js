// Parser Nequi (Colombia - billetera digital)
//
// Notificaciones tipicas:
//   From: notificaciones@nequi.com.co  o  no-reply@nequi.com.co
//   Subject: Te enviaron plata / Recibiste / Te transfirieron
//   Body: "Te enviaron $30.000" / "Recibiste $12.500 de Pedro"

import { parseAmount, hasOutgoingVerb, parseOutgoingAmount } from './parse-amount.js';

export const name = 'nequi';

export function matches(from, subject = '') {
  return (
    from.includes('nequi.com') ||
    from.includes('@nequi.') ||
    /nequi/i.test(subject)
  );
}

export function parse(text) {
  if (!text) return null;

  // 1) INGRESOS con verbo explícito pegado al monto.
  const inPatterns = [
    /(?:te\s+enviaron|recibiste|te\s+transfirieron|llegaron|te\s+consignaron)\s+\$?\s?([\d.,]+)/i,
    /(?:enviado|recibido|abono)\s+(?:por\s+)?\$?\s?([\d.,]+)/i,
  ];
  for (const re of inPatterns) {
    const m = text.match(re);
    if (m) {
      const amount = parseAmount(m[1]);
      if (amount > 0) {
        return { amount, currency: 'COP', bank: 'nequi', ref: null, direction: 'in' };
      }
    }
  }

  // 2) EGRESOS con verbo explícito ("Enviaste $30.000", "Pagaste $X").
  const outAmount = parseOutgoingAmount(text);
  if (outAmount > 0) {
    return { amount: outAmount, currency: 'COP', bank: 'nequi', ref: null, direction: 'out' };
  }

  // 3) Genéricos: SOLO si el correo no menciona verbos de egreso.
  if (!hasOutgoingVerb(text)) {
    const genericPatterns = [
      /\$\s?([\d.,]+)\s*(?:pesos)?\s+(?:de|por)/i,
      /\$\s?([\d.,]+)/i,
    ];
    for (const re of genericPatterns) {
      const m = text.match(re);
      if (m) {
        const amount = parseAmount(m[1]);
        if (amount > 0) {
          return { amount, currency: 'COP', bank: 'nequi', ref: null, direction: 'in' };
        }
      }
    }
  }

  return null;
}

