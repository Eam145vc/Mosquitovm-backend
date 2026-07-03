// Buffer en memoria de los últimos pagos anunciados, por cuenta. Lo usa la página
// /demo (el "altavoz web") para reproducir el anuncio cuando se detecta un pago real,
// y así demostrar el uso de los datos en el video de verificación.

const buf = []; // { accountId, amount, bank, localName, at }
const MAX = 80;

// localName/at opcionales para no romper a los llamadores viejos (/demo solo lee
// accountId/amount/bank/at). `at` viene de announcePayment: MISMO timestamp que la DB.
export function record({ accountId, amount, bank, localName = null, at = Date.now() }) {
  if (!accountId) return;
  buf.push({ accountId, amount, bank: bank || 'unknown', localName, at });
  if (buf.length > MAX) buf.shift();
}

export function recentFor(accountId, sinceMs = 0) {
  return buf.filter((a) => a.accountId === accountId && a.at > sinceMs);
}
