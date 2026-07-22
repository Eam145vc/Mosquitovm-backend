// Lee un QR wa.me (?text=...) de una imagen y ENVÍA ese texto EXACTO desde el
// número de Sonó por la Cloud API. Todo en Node → los acentos/UTF-8 se preservan
// (el paso por bash/SSH los corrompía y el match exacto de envia.com fallaba).
// Uso: WA_CLOUD_ACCESS_TOKEN=... WA_CLOUD_PHONE_NUMBER_ID=... node scripts/qr-verify-send.js <imagen>
import { Jimp } from 'jimp';
import jsQR from 'jsqr';

const file = process.argv[2];
const TOKEN = process.env.WA_CLOUD_ACCESS_TOKEN;
const PHONE_ID = process.env.WA_CLOUD_PHONE_NUMBER_ID;
if (!file || !TOKEN || !PHONE_ID) {
  console.error('faltan args/env'); process.exit(1);
}

const img = await Jimp.read(file);
const { data, width, height } = img.bitmap;
const code = jsQR(new Uint8ClampedArray(data), width, height);
if (!code) { console.error('NO_QR'); process.exit(2); }

const url = new URL(code.data);
const to = url.pathname.replace(/\D/g, '');           // número destino del wa.me
const text = url.searchParams.get('text') || '';       // ya URL-decoded, UTF-8 intacto
console.log('destino:', to);
console.log('texto  :', text);

const r = await fetch(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
});
const out = await r.json();
console.log(r.ok ? 'ENVIADO wamid: ' + (out.messages?.[0]?.id || '?') : 'ERROR: ' + JSON.stringify(out));
