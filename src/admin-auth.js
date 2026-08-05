// Identidad del agente que hace una request /admin/* o /soporte/admin/*.
// Dos usuarios: el DUEÑO (ADMIN_TOKEN) y el OPERARIO (OPERATOR_TOKEN). Sirve para
// saber quién escribe cada mensaje y para no mandarle el push de venta al operario.

import { config } from './config.js';

/** Devuelve { name, role: 'owner'|'operator' } según el header Authorization, o
 *  null si el token no es válido. */
export function agentFromAuth(authHeader) {
  const a = authHeader || '';
  if (config.ADMIN_TOKEN && a === `Bearer ${config.ADMIN_TOKEN}`) {
    return { name: config.ADMIN_AGENT_NAME || 'Dueño', role: 'owner' };
  }
  if (config.OPERATOR_TOKEN && a === `Bearer ${config.OPERATOR_TOKEN}`) {
    return { name: config.OPERATOR_USER || 'Operario', role: 'operator' };
  }
  if (config.CONTADOR_TOKEN && a === `Bearer ${config.CONTADOR_TOKEN}`) {
    return { name: config.CONTADOR_USER || 'Contador', role: 'contador' };
  }
  return null;
}
