// Prueba REAL de tokenización + cobro con token de EfiPay (producción).
// Tokeniza una tarjeta, cobra un monto mínimo con el token, y muestra la respuesta
// completa para ver exactamente DÓNDE viene el token y si el cobro aprueba.
//
// Uso (en el VM, en la carpeta del backend con el .env cargado):
//   CARD_HOLDER="NOMBRE APELLIDO" CARD_NUMBER="xxxxxxxxxxxxxxxx" CARD_EXP="2028-12" \
//   CARD_CVV="123" CARD_ID="123456789" AMOUNT="100" node scripts/test-token-charge.mjs
//
// ⚠️ Cobra de VERDAD (producción). Usar monto chico ($100). NO loguea el número.
// El reverso/anulación se hace MANUAL desde el panel de EfiPay con el transaction_id
// que imprime (EfiPay no siempre deja revertir por API en segundos).

const EFI = 'https://sag.efipay.co/api/v1';
const TOKEN = process.env.EFIPAY_TOKEN;
const OFFICE = process.env.EFIPAY_OFFICE || '6055';
if (!TOKEN) { console.error('FALTA EFIPAY_TOKEN en el entorno'); process.exit(1); }

const card = {
  holder: process.env.CARD_HOLDER,
  number: (process.env.CARD_NUMBER || '').replace(/\s/g, ''),
  datetime: process.env.CARD_EXP,   // yyyy-mm
  cvv: process.env.CARD_CVV,
  idNumber: process.env.CARD_ID || '0000000000',
};
const amount = Number(process.env.AMOUNT || '100');
const ref = 'test-token-' + Math.floor(Date.now() / 1000);

if (!card.holder || !card.number || !card.datetime || !card.cvv) {
  console.error('Faltan datos de tarjeta: CARD_HOLDER, CARD_NUMBER, CARD_EXP (yyyy-mm), CARD_CVV');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

async function post(path, body) {
  const r = await fetch(`${EFI}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// nunca imprime el número de tarjeta
function safe(obj) {
  const s = JSON.stringify(obj);
  return s.replace(card.number, '****' + card.number.slice(-4));
}

const run = async () => {
  console.log('== 1) TOKENIZAR ==');
  const tok = await post('/tokenized/', {
    holder: card.holder, number: card.number, datetime: card.datetime, cvv: card.cvv,
  });
  console.log('HTTP', tok.status, '→', safe(tok.data));
  if (!tok.ok) { console.error('Tokenización FALLÓ'); process.exit(2); }

  // dónde viene el token (probamos las variantes)
  const cardToken = tok.data.token || tok.data.data?.token || tok.data.payment_token || tok.data.data?.payment_token;
  console.log('\n>>> TOKEN extraído:', cardToken ? String(cardToken).slice(0, 12) + '…' : 'NO ENCONTRADO');
  if (!cardToken) { console.error('No se encontró el token en la respuesta — revisar la estructura de arriba'); process.exit(3); }

  console.log('\n== 2) GENERAR PAYMENT ($' + amount + ') ==');
  const gen = await post('/payment/generate-payment', {
    payment: { description: 'Sonó · test token', amount, currency_type: 'COP', checkout_type: 'api' },
    advanced_options: { references: [ref] },
    office: OFFICE,
  });
  console.log('HTTP', gen.status, '→', JSON.stringify(gen.data).slice(0, 200));
  if (!gen.ok || !gen.data.payment_id || !gen.data.token) { console.error('generate-payment FALLÓ'); process.exit(4); }

  console.log('\n== 3) COBRAR CON EL TOKEN ==');
  const charge = await post('/payment/transaction-checkout', {
    payment: { id: gen.data.payment_id, token: gen.data.token },
    customer_payer: {
      name: card.holder, email: 'test@sono.lat', country: 'COL', state: 'Bogota',
      city: 'Bogota', address_1: 'No informado', address_2: 'No informado', zip_code: '110111',
    },
    payment_card: {
      token: cardToken,
      identification_type: 'CC', id_number: String(card.idNumber),
      installments: '1', dialling_code: '+57', cellphone: '3000000000',
    },
  });
  console.log('HTTP', charge.status, '→', JSON.stringify(charge.data).slice(0, 400));
  const tx = charge.data.transaction || {};
  const status = tx.status || charge.data.status;
  const approved = /aprob|approv/i.test(String(status || ''));
  console.log('\n>>> RESULTADO COBRO:', approved ? 'APROBADO ✅' : 'NO aprobado ❌', '| status:', status);
  console.log('>>> transaction_id (para reversar en el panel):', tx.transaction_id || '(sin id)');
};

run().catch((e) => { console.error('ERROR:', e.message); process.exit(9); });
