// Lógica COMPARTIDA de montos para todos los parsers de bancos.
//
// Formatos reales vistos en producción:
//   "50.000"       -> 50000    (punto = miles, formato clásico CO)
//   "1.234.567"    -> 1234567
//   "204,000"      -> 204000   (coma = miles, formato nuevo Bancolombia jun-2026)
//   "1,600,000"    -> 1600000
//   "100.00"       -> 100      (punto = decimal, 2 dígitos — Bre-B)
//   "100,00"       -> 100      (coma = decimal)
//   "50.000,50"    -> 50000    (punto miles + coma decimal)
//   "1,600,000.50" -> 1600000  (coma miles + punto decimal)
//
// Regla: si hay AMBOS separadores, el que aparece de ÚLTIMO es el decimal.
// Si hay uno solo, es decimal únicamente cuando le siguen exactamente 2
// dígitos; en cualquier otro caso separa miles. Los centavos se descartan.
export function parseAmount(str) {
  if (!str) return 0;
  // El regex de captura puede arrastrar el punto/coma final de la frase
  // ("por $204,000." -> "204,000."): quitarlo antes de decidir.
  let s = String(str).trim().replace(/[.,]+$/, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    s = s.slice(0, Math.max(lastComma, lastDot)).replace(/[.,]/g, '');
  } else if (lastComma !== -1 || lastDot !== -1) {
    const last = Math.max(lastComma, lastDot);
    const after = s.slice(last + 1);
    s = (after.length === 2 ? s.slice(0, last) : s).replace(/[.,]/g, '');
  }

  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

// Verbos de EGRESO (plata que SALE de la cuenta del comerciante):
// "Transferiste $X desde tu cuenta...", "Pagaste...", "Compra por...".
// OJO: NO usar un detector de "ingreso" por keyword suelta para anular esto —
// el boilerplate de Bancolombia trae "Recibiste este correo porque..." y eso
// hacía pasar egresos como ingresos (bug visto en producción jun-2026).
// La precedencia correcta la decide cada parser: (1) verbo de ingreso CON
// monto pegado, (2) verbo de egreso CON monto pegado, (3) genérico solo si
// no hay verbo de egreso en el texto.
const OUTGOING_RE = /\b(transferiste|enviaste|pagaste|compraste|retiraste|hiciste\s+un\s+pago|realizaste\s+un\s+env[ií]o|reverso|compra\s+por|retiro\s+(?:por|de)|pago\s+exitoso\s+a)\b/i;

// Asuntos que NUNCA son una venta entrante (correos reales de Nequi, jul-2026):
//   "¡Enviaste plata por Bre-B!"        → envío Bre-B que HACE el dueño
//   "¡Pago exitoso!" / "¡Pago rechazado!" → "Hiciste un pago en X por $Y" (dueño paga)
//   "Te hicimos un reverso."            → devolución, no es venta
//   "Cambiaste los montos en tu Nequi"  → config de topes, trae cifras pero no es pago
// Con estos asuntos JAMÁS se devuelve direction 'in' (anunciarlos hizo sonar
// egresos como ventas en producción — bug jul-2026, ver tests).
const NON_INCOMING_SUBJECT_RE = /enviaste\s+plata|pago\s+(?:exitoso|rechazado)|realizaste\s+un\s+env|reverso|cambiaste\s+los\s+montos/i;

export function isNonIncomingSubject(subject) {
  return NON_INCOMING_SUBJECT_RE.test(subject || '');
}

export function hasOutgoingVerb(text) {
  return OUTGOING_RE.test(text);
}

// Extrae el monto de un correo de EGRESO ("Transferiste $1,600,000 desde tu
// cuenta...", "Enviaste $30.000", "Pagaste $X"). Los parsers lo devuelven con
// direction:'out' y announcePayment decide si se anuncia según la flag
// announce_outgoing de la cuenta (futuro toggle del panel de usuario).
const OUTGOING_AMOUNT_RES = [
  /(?:transferiste|enviaste|pagaste|compraste|retiraste)\s+\$?\s?([\d.,]+)/i,
  // Nequi Bre-B: "Enviaste de manera exitosa 60.000 a la llave @x" (sin $)
  /enviaste\s+de\s+manera\s+exitosa\s+\$?\s?([\d.,]+)/i,
  // Nequi: "Hiciste un pago en Mercadopago Colombia S.A. por $200.000"
  /hiciste\s+un\s+pago\s+[^$]{0,80}?\$\s?([\d.,]+)/i,
  // Nequi: "Recibiste un reverso por $ 27.119,66" (devolución, no venta)
  /reverso\s+por\s+\$?\s?([\d.,]+)/i,
  /(?:compra|retiro|pago)\s+(?:por|de)\s+\$?\s?([\d.,]+)/i,
];

export function parseOutgoingAmount(text) {
  for (const re of OUTGOING_AMOUNT_RES) {
    const m = text.match(re);
    if (m) {
      const amount = parseAmount(m[1]);
      if (amount > 0) return amount;
    }
  }
  return 0;
}
