// Parser BBVA Colombia (Bre-B)
//
// Notificación REAL de pago (capturada jul-2026 vía alias redirigido):
//
//   From: notificacionesBreB@bbva.com
//   Subject: Recibiste dinero en tu cuenta a través de Bre-B.
//   Body (tras stripHtml): "... ya está disponible en tu Cuenta BBVA el dinero que
//   EMMANUEL ALVAREZ MARTINEZ envió a tu llave de Alfanumérica. ... Detalles de la
//   operación Fecha y hora 2026/07/14 10:59 Valor recibido $ 2,00 Persona que envía
//   EMMANUEL ALVAREZ MARTINEZ Tipo de llave Alfanumérica Cuenta destino *****6365
//   Código de operación 10025826415270422590157636204918224 ..."
//
// BBVA usa coma decimal ("$ 2,00", "$ 1.500,00") — parseAmount ya lo maneja.
// OJO: bbvanet.com.co también manda correos NO-pago ("Actualizaste tu email
// principal") y marketing con precios: matches() los acepta pero parse() es
// ESTRICTO (solo patrones de ingreso explícitos, sin genérico "$X" pelado) para
// no anunciar publicidad como pago. Si BBVA cambia el formato, relajar acá.
// El correo NO trae la llave Bre-B (solo su tipo, "Alfanumérica") → sin brebKey
// para ruteo multipunto; sí trae la cuenta destino por si sirve a futuro.

import { parseAmount } from './parse-amount.js';

export const name = 'bbva';

export function matches(from, subject = '') {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();
  return f.includes('bbva') || s.includes('bbva');
}

export function parse(text) {
  if (!text) return null;

  // Cuenta destino ("Cuenta destino *****6365") para ruteo futuro.
  let account = null;
  const mAcc = text.match(/cuenta\s+destino\s+\**(\d{3,})/i);
  if (mAcc) account = mAcc[1];

  // Referencia: "Código de operación 10025826..."
  let ref = null;
  const mRef = text.match(/c[oó]digo\s+de\s+operaci[oó]n\s+(\d{6,})/i);
  if (mRef) ref = mRef[1];

  // Solo INGRESOS explícitos (ver nota de arriba: sin patrón genérico).
  const inPatterns = [
    // "Valor recibido $ 2,00" — el campo confiable del detalle de la operación
    /valor\s+recibido\s+\$?\s?([\d.,]+)/i,
    // fallback por si cambia el detalle: "Recibiste ... $ X" con el verbo cerca
    /recibiste\s+[^$]{0,80}\$\s?([\d.,]+)/i,
  ];
  for (const re of inPatterns) {
    const m = text.match(re);
    if (m) {
      const amount = parseAmount(m[1]);
      if (amount > 0) {
        return { amount, currency: 'COP', bank: 'bbva', ref, direction: 'in', account };
      }
    }
  }

  return null;
}
