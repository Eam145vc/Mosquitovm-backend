// Crea las plantillas de WhatsApp Cloud API en el WABA vía Graph y detecta drift
// entre src/wa-templates.js y lo que Meta tiene registrado.
// Uso (standalone, NO necesita el resto del .env del backend):
//   WA_CLOUD_ACCESS_TOKEN=... WA_CLOUD_WABA_ID=... node scripts/create-wa-templates.js
// Importa SOLO src/wa-templates.js (módulo sin dependencias) — no arrastra el Zod
// de config.js que exige MQTT_URL y demás.

import { WA_TEMPLATES } from '../src/wa-templates.js';

const TOKEN = process.env.WA_CLOUD_ACCESS_TOKEN;
const WABA = process.env.WA_CLOUD_WABA_ID;
const VERSION = process.env.WA_CLOUD_GRAPH_VERSION || 'v25.0';

if (!TOKEN || !WABA) {
  console.error('Faltan WA_CLOUD_ACCESS_TOKEN y/o WA_CLOUD_WABA_ID en el entorno.');
  process.exit(1);
}

const graph = async (path, init = {}) => {
  const r = await fetch(`https://graph.facebook.com/${VERSION}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
};

function toMetaComponents(def) {
  const components = [
    { type: 'BODY', text: def.body, example: { body_text: [def.bodyExample] } },
  ];
  if (def.button) {
    components.push({
      type: 'BUTTONS',
      buttons: [{
        type: 'URL',
        text: def.button.text,
        url: `${def.button.urlBase}{{1}}`,
        example: [`${def.button.urlBase}abc123`],
      }],
    });
  }
  return components;
}

// 1) Estado actual en Meta: para detectar drift (el body local cambió pero la
// plantilla registrada sigue con el texto viejo → los params no matchean y todos
// los envíos de ese kind fallarían con #132000 sin que los tests lo detecten).
const existing = new Map();
{
  const { ok, data } = await graph(`/${WABA}/message_templates?fields=name,status,components&limit=200`);
  if (ok) {
    for (const t of data.data || []) {
      const body = (t.components || []).find((c) => c.type === 'BODY')?.text || '';
      existing.set(t.name, { status: t.status, body });
    }
  } else {
    console.warn(`⚠️  No se pudo listar plantillas existentes (${data?.error?.message || 'error'}); solo se intenta crear.`);
  }
}

// 2) Crear las que falten; avisar drift en las que existan. Cada plantilla en su
// propio try: un fallo de red en la 3 no deja a las 8 restantes sin intentar.
let drift = 0;
for (const [name, def] of Object.entries(WA_TEMPLATES)) {
  try {
    const prev = existing.get(name);
    if (prev) {
      if (prev.body === def.body) {
        console.log(`↩️  ${name}: ya existe (${prev.status}), sin cambios`);
      } else {
        drift += 1;
        console.error(`🔶 ${name}: DRIFT — el body local difiere del registrado en Meta (${prev.status}).`);
        console.error(`     Meta : ${prev.body}`);
        console.error(`     Local: ${def.body}`);
        console.error('     Meta no permite editar por API: crea una versión nueva (ej. sufijo _v2) o edítala en WhatsApp Manager.');
      }
      continue;
    }
    const { ok, status, data } = await graph(`/${WABA}/message_templates`, {
      method: 'POST',
      body: JSON.stringify({ name, category: 'UTILITY', language: 'es', components: toMetaComponents(def) }),
    });
    if (ok) {
      console.log(`✅ ${name}: creada (estado ${data.status})`);
    } else {
      const msg = `${data?.error?.error_user_title || ''} ${data?.error?.message || ''}`.toLowerCase();
      if (msg.includes('already exists')) console.log(`↩️  ${name}: ya existía`);
      else console.error(`❌ ${name}: ${data?.error?.message || `HTTP ${status}`}`);
    }
  } catch (e) {
    console.error(`❌ ${name}: ${e.message} (¿red caída? se continúa con las demás)`);
  }
}
if (drift) console.error(`\n🔶 ${drift} plantilla(s) con drift: el enviador usará los params del código contra el texto viejo de Meta — resolver ANTES de activar.`);
