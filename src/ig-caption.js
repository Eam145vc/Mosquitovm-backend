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

Tu tarea: mirar la imagen o video adjunto y escribir el CAPTION para un post de Instagram.

REGLAS:
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
- Largo total ideal: 3-6 líneas + hashtags. NUNCA pasar de 2200 caracteres.
- NO inventes precios, promesas ni datos que no conozcas.

FORMATO DE SALIDA: devuelve SOLO el texto del caption, listo para pegar. Sin comillas,
sin markdown, sin explicaciones, sin "Aquí está tu caption".
`.trim();

/**
 * Analiza un archivo (imagen o video) y devuelve un caption de marketing.
 * @param {Buffer} buffer
 * @param {string} mimeType  ej. 'image/jpeg', 'video/mp4'
 * @param {string} [hint]    pista opcional del usuario (ej. "es el lanzamiento del plan anual")
 * @returns {Promise<string>}  el caption
 */
export async function generateCaption(buffer, mimeType, hint = '') {
  if (!config.GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY en el backend');

  const userParts = [
    { inlineData: { mimeType, data: buffer.toString('base64') } },
    { text: hint
        ? `Contexto que da el usuario: "${hint}". Escribe el caption para este post.`
        : 'Escribe el caption para este post.' },
  ];

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 1024 }, // alta: queremos creatividad
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
    const caption = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (!caption) throw new Error('Gemini no devolvió caption');
    // Saneo: quitar comillas envolventes o fences si el modelo los puso.
    return caption.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').replace(/^["']|["']$/g, '').trim().slice(0, 2200);
  } finally {
    clearTimeout(t);
  }
}
