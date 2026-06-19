// Parser Daviplata (Colombia)

import { parseAmount, hasOutgoingVerb, parseOutgoingAmount } from './parse-amount.js';

export const name = 'daviplata';

export function matches(from, subject = '') {
  return (
    from.includes('daviplata') ||
    from.includes('@davivienda.com') && /daviplata/i.test(subject) ||
    /daviplata/i.test(subject)
  );
}

export function parse(text) {
  if (!text) return null;
  const m1 = text.match(/(?:recibiste|te\s+enviaron|abonaron)\s+\$?\s?([\d.,]+)/i);
  if (m1) {
    const amount = parseAmount(m1[1]);
    if (amount > 0) return { amount, currency: 'COP', bank: 'daviplata', ref: null, direction: 'in' };
  }
  const outAmount = parseOutgoingAmount(text);
  if (outAmount > 0) return { amount: outAmount, currency: 'COP', bank: 'daviplata', ref: null, direction: 'out' };
  if (!hasOutgoingVerb(text)) {
    const m2 = text.match(/\$\s?([\d.,]+)/);
    if (m2) {
      const amount = parseAmount(m2[1]);
      if (amount > 0) return { amount, currency: 'COP', bank: 'daviplata', ref: null, direction: 'in' };
    }
  }
  return null;
}

