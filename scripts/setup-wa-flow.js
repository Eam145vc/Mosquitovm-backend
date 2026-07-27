// Provisiona el WhatsApp Flow del cobro de cuotas contra Meta Graph.
//
// Uso (standalone, con el token/WABA/PHONE del .env del VM):
//   node scripts/setup-wa-flow.js keys                 → genera el par RSA (imprime el .env)
//   node scripts/setup-wa-flow.js upload-key           → sube la pública a Meta
//   node scripts/setup-wa-flow.js create               → crea el Flow (imprime WA_FLOW_ID)
//   node scripts/setup-wa-flow.js json                 → sube/actualiza el Flow JSON
//   node scripts/setup-wa-flow.js publish              → publica (Meta hace ping al endpoint)
//   node scripts/setup-wa-flow.js status               → estado actual
//
// Orden real: keys → (poner la privada en el .env del VM + deploy) → upload-key →
// create → json → publish. El publish exige que el endpoint YA responda el ping.

import crypto from 'node:crypto';
import { FLOW_JSON } from '../src/wa-flow-json.js';

const TOKEN = process.env.WA_CLOUD_ACCESS_TOKEN;
const WABA = process.env.WA_CLOUD_WABA_ID;
const PHONE = process.env.WA_CLOUD_PHONE_NUMBER_ID;
const VERSION = process.env.WA_CLOUD_GRAPH_VERSION || 'v25.0';
const FLOW_ID = process.env.WA_FLOW_ID || '';
const FLOW_NAME = 'sono_cuotas';
const ENDPOINT = process.env.WA_FLOW_ENDPOINT || 'https://api.sono.lat/webhook/wa-flow';

const cmd = process.argv[2] || 'status';

if (cmd !== 'keys' && (!TOKEN || !WABA)) {
  console.error('Faltan WA_CLOUD_ACCESS_TOKEN y/o WA_CLOUD_WABA_ID en el entorno.');
  process.exit(1);
}

const graph = async (path, init = {}) => {
  const r = await fetch(`https://graph.facebook.com/${VERSION}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
};

const graphJson = (path, body, method = 'POST') =>
  graph(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ── keys: par RSA-2048. Meta envuelve con la pública la AES efímera de cada request.
if (cmd === 'keys') {
  const passphrase = crypto.randomBytes(18).toString('base64url');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'des-ede3-cbc', passphrase },
  });
  console.log('=== PEGAR EN EL .env DEL VM (la privada NUNCA sale del server) ===');
  console.log(`WA_FLOW_PRIVATE_KEY="${privateKey.trim().replace(/\n/g, '\\n')}"`);
  console.log(`WA_FLOW_PASSPHRASE=${passphrase}`);
  console.log('\n=== PÚBLICA (se sube a Meta con: node scripts/setup-wa-flow.js upload-key) ===');
  console.log(publicKey.trim());
  console.log('\nGuárdala también en WA_FLOW_PUBLIC_KEY del entorno para el paso upload-key.');
  process.exit(0);
}

// ── upload-key: registra la pública en el número de WhatsApp.
if (cmd === 'upload-key') {
  const pub = process.env.WA_FLOW_PUBLIC_KEY;
  if (!pub || !PHONE) {
    console.error('Faltan WA_FLOW_PUBLIC_KEY y/o WA_CLOUD_PHONE_NUMBER_ID.');
    process.exit(1);
  }
  const params = new URLSearchParams({ business_public_key: pub.replace(/\\n/g, '\n') });
  const { ok, data } = await graph(`/${PHONE}/whatsapp_business_encryption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  console.log(ok ? '✅ llave pública registrada' : `❌ ${data?.error?.message || 'error'}`);
  const check = await graph(`/${PHONE}/whatsapp_business_encryption`);
  console.log('estado:', JSON.stringify(check.data));
  process.exit(ok ? 0 : 1);
}

// ── create: crea el Flow (o reporta el existente con el mismo nombre).
if (cmd === 'create') {
  const list = await graph(`/${WABA}/flows?limit=50`);
  const prev = (list.data?.data || []).find((f) => f.name === FLOW_NAME);
  if (prev) {
    console.log(`↩️  ya existe: ${FLOW_NAME} (${prev.status})`);
    console.log(`WA_FLOW_ID=${prev.id}`);
    process.exit(0);
  }
  const { ok, data } = await graphJson(`/${WABA}/flows`, {
    name: FLOW_NAME,
    categories: ['OTHER'],
    endpoint_uri: ENDPOINT,
  });
  if (!ok) {
    console.error(`❌ ${data?.error?.message || 'error creando el flow'}`);
    process.exit(1);
  }
  console.log('✅ Flow creado');
  console.log(`WA_FLOW_ID=${data.id}`);
  process.exit(0);
}

if (!FLOW_ID) {
  console.error('Falta WA_FLOW_ID en el entorno (córrelo después de `create`).');
  process.exit(1);
}

// ── json: sube el Flow JSON como asset (reemplaza el anterior).
if (cmd === 'json') {
  // Aseguramos el endpoint por si el Flow se creó sin él.
  await graphJson(`/${FLOW_ID}`, { endpoint_uri: ENDPOINT });
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', new Blob([JSON.stringify(FLOW_JSON)], { type: 'application/json' }), 'flow.json');
  const { ok, data } = await graph(`/${FLOW_ID}/assets`, { method: 'POST', body: form });
  if (!ok) {
    console.error(`❌ ${data?.error?.message || 'error subiendo el JSON'}`);
    process.exit(1);
  }
  const errs = data.validation_errors || [];
  console.log(errs.length ? '⚠️  subido CON errores de validación:' : '✅ Flow JSON subido sin errores');
  for (const e of errs) console.log('   -', e.message || JSON.stringify(e));
  process.exit(errs.length ? 1 : 0);
}

// ── publish: Meta hace ping al endpoint; si no responde bien, falla acá.
if (cmd === 'publish') {
  const { ok, data } = await graph(`/${FLOW_ID}/publish`, { method: 'POST' });
  console.log(ok ? '✅ Flow PUBLICADO' : `❌ ${data?.error?.error_user_msg || data?.error?.message || 'error'}`);
  process.exit(ok ? 0 : 1);
}

// ── status
const { data } = await graph(`/${FLOW_ID}?fields=id,name,status,categories,validation_errors,endpoint_uri`);
console.log(JSON.stringify(data, null, 2));
