// Parser de emails de Bancolombia (Colombia)
//
// Formato tipico de notificacion:
//
//   From: alertasynotificaciones@notificacionesbancolombia.com
//   Subject: Bancolombia te informa Recepcion transferencia
//   Body: ...Recibiste una transferencia por $50.000 de JUAN PEREZ...
//   O:    ...Tu cuenta de ahorros termina en XXXX recibio $12.345...

import { parseAmount, hasOutgoingVerb, parseOutgoingAmount } from './parse-amount.js';

export const name = 'bancolombia';

export function matches(from, subject = '') {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();
  return (
    f.includes('bancolombia.com') ||                  // cubre an.notificacionesbancolombia.com, etc.
    f.includes('bancolombia') ||
    s.includes('bancolombia') ||
    s.includes('alertas y notificaciones')            // asunto real de Bre-B/alertas Bancolombia
  );
}

export function parse(text) {
  if (!text) return null;

  // 1) INGRESOS con verbo explícito PEGADO al monto. Van primero: si el correo
  //    dice "recibiste un pago por $X", es ingreso sin importar el resto.
  const inPatterns = [
    // "Recibiste una transferencia por $50.000" / "recibiste un pago de FULANO por $100.00"
    /recib(?:iste|imos|i[oó])\s+(?:una?\s+)?(?:transferencia|consignaci[oó]n|pago|abono)\s+(?:de\s+[^$]{0,60}?)?(?:por\s+)?\$?\s?([\d.,]+)/i,
    // "abono por $12.345"
    /abono\s+(?:por\s+)?\$?\s?([\d.,]+)/i,
    // "te abonaron $X" / "depositaron $X"
    /(?:te\s+abonaron|depositaron|consignaron|transfirieron)\s+\$?\s?([\d.,]+)/i,
    // "recibio $X" (cuenta termina en XXXX recibio $X)
    /recibi[oó]\s+\$?\s?([\d.,]+)/i,
  ];
  for (const re of inPatterns) {
    const m = text.match(re);
    if (m) {
      const amount = parseAmount(m[1]);
      if (amount > 0) {
        return { amount, currency: 'COP', bank: 'bancolombia', ref: null, direction: 'in' };
      }
    }
  }

  // 2) EGRESOS con verbo explícito pegado al monto ("Transferiste $1,600,000").
  //    Va ANTES del patrón genérico: el boilerplate del correo ("Recibiste este
  //    correo porque...") contiene "recib" y hacía anunciar egresos como ingresos.
  const outAmount = parseOutgoingAmount(text);
  if (outAmount > 0) {
    return { amount: outAmount, currency: 'COP', bank: 'bancolombia', ref: null, direction: 'out' };
  }

  // 3) Genérico "$X" pelado: SOLO si el correo no menciona ningún verbo de egreso.
  if (!hasOutgoingVerb(text)) {
    const m = text.match(/\$\s?([\d.,]+)\s*(?:pesos|cop)?/i);
    if (m) {
      const amount = parseAmount(m[1]);
      if (amount > 0) {
        return { amount, currency: 'COP', bank: 'bancolombia', ref: null, direction: 'in' };
      }
    }
  }

  return null;
}

