// Registry de parsers de emails de bancos colombianos.
// Cada parser exporta:
//   - matches(from, subject): boolean
//   - parse(textOrHtml): { amount, currency, bank, ref } | null

import * as bancolombia from './bancolombia.js';
import * as nequi from './nequi.js';
import * as daviplata from './daviplata.js';
import * as davivienda from './davivienda.js';
import * as generic from './generic.js';

const PARSERS = [bancolombia, nequi, daviplata, davivienda];

/**
 * Intenta parsear un email de notificacion de pago.
 *
 * @param {Object} email
 * @param {string} email.from        - From completo (ej: "Alertas <alertas@banco.com>")
 * @param {string} email.subject     - Asunto
 * @param {string} email.text        - Cuerpo en texto plano
 * @param {string} [email.html]      - Cuerpo HTML (fallback si no hay text)
 * @returns {{ amount, currency, bank, ref, parser } | null}
 */
export function parseEmail(email) {
  const from = (email.from || '').toLowerCase();
  const subject = email.subject || '';
  const text = email.text || stripHtml(email.html || '');

  for (const p of PARSERS) {
    if (p.matches(from, subject)) {
      const result = p.parse(text);
      if (result) {
        return { ...result, parser: p.name };
      }
    }
  }

  // Fallback: regex generica
  return generic.parse(text);
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
