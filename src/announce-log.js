// Buffer en memoria de los últimos pagos anunciados, por cuenta. Lo usa la página
// /demo (el "altavoz web") para reproducir el anuncio cuando se detecta un pago real,
// y así demostrar el uso de los datos en el video de verificación.

const buf = []; // { accountId, amount, bank, at }
const MAX = 80;

export function record({ accountId, amount, bank }) {
  if (!accountId) return;
  buf.push({ accountId, amount, bank: bank || 'unknown', at: Date.now() });
  if (buf.length > MAX) buf.shift();
}

export function recentFor(accountId, sinceMs = 0) {
  return buf.filter((a) => a.accountId === accountId && a.at > sinceMs);
}
