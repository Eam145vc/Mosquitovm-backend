// OAuth2 helper para Google (Gmail IMAP via XOAUTH2).
//
// Flujo:
//   1. buildAuthUrl(clientInternalId, speakerId)  -> URL para que el cliente acepte
//   2. exchangeCodeForTokens(code)                -> { refresh_token, access_token, email }
//   3. refreshAccessToken(refresh_token)          -> access_token (con 1h validez)
//
// Scope: gmail.readonly - solo lectura, mas facil de aprobar por Google.

import { config } from './config.js';
import { logger } from './logger.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

// Gmail se lee por la Gmail API (no IMAP), así que usamos el scope de SOLO LECTURA
// gmail.readonly (más fácil de verificar; el consentimiento dice solo "leer").
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

/**
 * Genera URL para que el cliente acepte el consent screen de Google.
 * Pasa el state = id_interno|speaker_id para reidentificarlo en el callback.
 */
export function buildAuthUrl({ clientInternalId, speakerId }) {
  if (!config.hasOAuth) throw new Error('GOOGLE_CLIENT_ID/SECRET no configurados');

  const state = encodeURIComponent(`${clientInternalId}|${speakerId || config.SPEAKER_DEVICE_ID}`);
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',         // para recibir refresh_token
    prompt: 'consent',              // forzar refresh_token nuevo cada vez
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Intercambia el `code` recibido en el callback por tokens.
 * Devuelve refresh_token, access_token, email del usuario.
 */
export async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`token exchange failed: HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  // data = { access_token, refresh_token, expires_in, token_type, scope, id_token }

  // Validar que el usuario haya concedido lectura de Gmail. Aceptamos gmail.readonly
  // (el scope que pedimos ahora) o mail.google.com (cuentas conectadas antes, que lo incluye).
  const grantedScopes = String(data.scope || '').split(/\s+/);
  const hasGmailRead =
    grantedScopes.includes('https://www.googleapis.com/auth/gmail.readonly') ||
    grantedScopes.includes('https://mail.google.com/');
  if (!hasGmailRead) {
    throw new Error(
      'SCOPE_MISSING: el usuario no concedio el permiso de leer Gmail. Scopes recibidos: ' +
      grantedScopes.join(', ')
    );
  }

  // Sin refresh_token = ya habia consentimiento previo y Google no manda uno nuevo.
  // NO fallamos aca: el caller reusa el refresh_token guardado si el correo ya estaba
  // conectado (asi un reintento no rompe el flujo en produccion).

  // Obtener email del usuario
  const userResp = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!userResp.ok) {
    throw new Error(`userinfo failed: ${userResp.status}`);
  }
  const user = await userResp.json();

  return {
    refreshToken: data.refresh_token || null,
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    email: user.email,
    grantedScopes,
  };
}

/**
 * Renueva el access_token usando el refresh_token guardado.
 * Devuelve { accessToken, expiresIn }.
 */
export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`refresh failed: ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}
