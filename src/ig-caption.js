// Genera el caption de un post de Instagram analizando la imagen/video con Gemini Vision.
// Tono: marketing de Sonó (sono.lat) — vender el altavoz que anuncia pagos QR en comercios CO.
//
// Reusa la API REST de Gemini (generateContent), igual que support/gemini.js, sin SDK.

import { config } from './config.js';
import { logger } from './logger.js';

const MODEL = config.GEMINI_MODEL || 'gemini-flash-latest';
const API = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const SYSTEM_PROMPT = `
Eres el community manager de Sonó (sono.lat): un altavoz IoT que anuncia por voz los pagos
QR que recibe un comercio en Colombia ("Recibiste cinco mil pesos"). El público son dueños
de comercios y emprendedores colombianos.

Tu tarea: mirar la imagen o video adjunto y escribir TRES (3) opciones DISTINTAS de CAPTION
para un post de Instagram, con ángulos diferentes (ej: una emocional/del dolor, otra directa
al beneficio, otra más fresca/divertida). Cada una debe poder publicarse tal cual.

REGLAS (para cada caption):
- Español de Colombia, con TÚ (nunca "vos").
- Punchy y orientado a VENDER, pero natural (no sonar a anuncio robótico).
- Engancha en la primera línea (el "gancho" que se ve sin abrir el "ver más").
- Conecta lo que se ve en la imagen/video con un beneficio de Sonó cuando tenga sentido
  (no más mirar el celular, suena solo cuando la plata entró de verdad, cero comisión,
  llega listo para enchufar). Si la imagen no se relaciona con el producto, describe lo que
  ves de forma atractiva igual.
- Usa emojis con criterio (no en exceso).
- Cierra con un CTA suave (ej: "Pide el tuyo en sono.lat 🟢").
- Agrega 5-10 hashtags relevantes al final (mezcla marca + nicho:
  #Sono #PagosQR #ComercioColombia #Emprendimiento #Negocios, etc.).
- Largo ideal de cada uno: 3-6 líneas + hashtags. NUNCA pasar de 2200 caracteres.
- Las 3 deben ser CLARAMENTE diferentes entre sí (no variaciones mínimas).
- NO inventes precios, promesas ni datos que no conozcas.

FORMATO DE SALIDA (obligatorio): devuelve SOLO un objeto JSON válido, sin markdown ni texto
extra, con exactamente esta forma:
{"captions": ["<caption 1 completo>", "<caption 2 completo>", "<caption 3 completo>"]}
`.trim();

/**
 * Analiza un archivo (imagen o video) y devuelve 3 opciones de caption de marketing.
 * @param {Buffer} buffer
 * @param {string} mimeType  ej. 'image/jpeg', 'video/mp4'
 * @param {string} [hint]    pista opcional del usuario (ej. "es el lanzamiento del plan anual")
 * @returns {Promise<string[]>}  array de 3 captions
 */
export async function generateCaption(buffer, mimeType, hint = '') {
  if (!config.GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY en el backend');

  const userParts = [
    { inlineData: { mimeType, data: buffer.toString('base64') } },
    { text: hint
        ? `Contexto que da el usuario: "${hint}". Escribe las 3 opciones de caption para este post.`
        : 'Escribe las 3 opciones de caption para este post.' },
  ];

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: {
      temperature: 0.95,            // alta: queremos 3 ángulos bien distintos
      maxOutputTokens: 3072,        // holgado: 3 captions completos con hashtags
      responseMimeType: 'application/json',
    },
  };

  const ctrl = new AbortController();
  // El video tarda más en analizarse → timeout generoso.
  const t = setTimeout(() => ctrl.abort(), mimeType.startsWith('video/') ? 60000 : 30000);
  try {
    const res = await fetch(API(MODEL, config.GEMINI_API_KEY), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logger.error({ status: res.status, txt: txt.slice(0, 300) }, 'ig-caption gemini http error');
      throw new Error(`Gemini respondió ${res.status}`);
    }
    const data = await res.json();
    const raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (!raw) throw new Error('Gemini no devolvió nada');

    const parsed = safeParse(raw);
    let captions = Array.isArray(parsed?.captions) ? parsed.captions : null;
    // Fallback: si no vino el JSON esperado, usar el texto crudo como 1 caption.
    if (!captions || captions.length === 0) {
      const single = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
      captions = [single];
    }
    // Saneo cada caption y limita a 2200 chars (límite de Instagram). Máx 3.
    return captions
      .map((c) => String(c || '').trim().slice(0, 2200))
      .filter(Boolean)
      .slice(0, 3);
  } finally {
    clearTimeout(t);
  }
}

// Parseo tolerante del JSON (puede venir envuelto en ```json … ```).
function safeParse(raw) {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
