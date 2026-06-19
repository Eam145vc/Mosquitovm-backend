// Speaker simulado: se conecta al mismo broker MQTT y escucha el topic del speaker.
// Cuando llega un comando de voz, imprime lo que el speaker REAL reproduciría.
// Sirve para probar el flujo punta a punta sin hardware. Lee MQTT_* del .env del backend.
//
// Uso (en el VM, desde la carpeta del backend):
//   set -a; source .env; set +a; node sim-speaker.js [spkr-001]

import mqtt from 'mqtt';

const SPEAKER = process.argv[2] || process.env.SPEAKER_DEVICE_ID || 'spkr-001';
const URL = process.env.MQTT_URL;
const USER = process.env.MQTT_USERNAME;
const PASS = process.env.MQTT_PASSWORD;

if (!URL) {
  console.error('Falta MQTT_URL (corré: set -a; source .env; set +a; node sim-speaker.js)');
  process.exit(1);
}

// IDs de WAV → palabra, para "leer" en voz alta lo que diría el speaker (aproximado).
// Basado en el pack es-CO. Solo para que el log sea legible.
const WORDS = {
  '070': 'Recibiste', '073': 'pesos', '080': 'de', '064': 'pesos',
  '107': 'cincuenta mil', '104': 'diez mil', '103': 'cinco mil',
  '049': 'cien', '060': 'mil', '061': 'un millón',
};

function describe(playAudibleMsg) {
  const ids = String(playAudibleMsg || '').split('-');
  const words = ids.map((id) => WORDS[id] || `[${id}]`).join(' ');
  return words;
}

const topic = `speakers/${SPEAKER}/cmd`;
console.log(`🔌 Speaker simulado conectando a ${URL} ...`);
console.log(`👂 Escuchando topic: ${topic}\n`);

const client = mqtt.connect(URL, {
  username: USER,
  password: PASS,
  reconnectPeriod: 3000,
});

client.on('connect', () => {
  console.log('✅ Conectado al broker.');
  client.subscribe(topic, { qos: 1 }, (err) => {
    if (err) console.error('❌ Error al suscribir:', err.message);
    else console.log(`✅ Suscrito a ${topic}. Esperando comandos...\n`);
  });
});

client.on('message', (t, payload) => {
  const ts = new Date().toISOString();
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch { msg = payload.toString(); }
  console.log('───────────────────────────────────────────');
  console.log(`📢 [${ts}] COMANDO RECIBIDO en ${t}`);
  console.log('   payload:', JSON.stringify(msg));
  if (msg && msg.cmd === 'voice') {
    console.log(`   🔊 EL SPEAKER DIRÍA: "${describe(msg.playAudibleMsg)}"`);
    if (msg.amount) console.log(`   💵 Monto: $${Number(msg.amount).toLocaleString('es-CO')}`);
  }
  console.log('───────────────────────────────────────────\n');
});

client.on('error', (e) => console.error('MQTT error:', e.message));
process.on('SIGINT', () => { client.end(); process.exit(0); });
