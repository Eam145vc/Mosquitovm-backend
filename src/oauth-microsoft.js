// OAuth2 helper para Microsoft (Outlook/Hotmail/Live/Office365) -> IMAP via XOAUTH2.
//
// Flujo idéntico a oauth.js (Google) pero contra el endpoint de Microsoft Identity.
// Scope clave para leer correo por IMAP: https://outlook.office.com/IMAP.AccessAsUser.All
//
// Diferencias con Google:
//  - El email del usuario se saca decodificando el id_token (claim email/preferred_username),
//    sin llamada extra (el access_token es de audiencia outlook.office.com, no de Graph).
//  - Microsoft ROTA el refresh_token en cada renovación: refreshAccessToken devuelve uno nuevo.

import { config } from './config.js';

const IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All';
const SCOPES = ['openid', 'email', 'profile', 'offline_access', IMAP_SCOPE];

const authBase = () =>
  `https://login.microsoftonline.com/${config.MICROSOFT_TENANT}/oauth2/v2.0`;

export function buildAuthUrl({ clientInternalId, speakerId }) {
  if (!config.hasMsOAuth) throw new Error('MICROSOFT_CLIENT_ID/SECRET no configurados');
  const state = encodeURIComponent(`${clientInternalId}|${speakerId || ''}`);
  const params = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID,
    redirect_uri: config.MICROSOFT_REDIRECT_URI,
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    prompt: 'select_account',
  });
  return `${authBase()}/authorize?${params.toString()}`;
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'),
    );
    return payload.email || payload.preferred_username || payload.upn || null;
  } catch {
    return null;
  }
}

export async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID,
    client_secret: config.MICROSOFT_CLIENT_SECRET,
    redirect_uri: config.MICROSOFT_REDIRECT_URI,
    grant_type: 'authorization_code',
    code,
    scope: SCOPES.join(' '),
  });

  const resp = await fetch(`${authBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MS token exchange failed: HTTP ${resp.status}: ${text}`);
  }
  const data = await resp.json();

  const grantedScopes = String(data.scope || '').split(/\s+/);
  if (!grantedScopes.some((s) => s.toLowerCase().includes('imap.accessasuser.all'))) {
    throw new Error('SCOPE_MISSING: faltó el permiso de IMAP. Scopes: ' + grantedScopes.join(', '));
  }
  if (!data.refresh_token) {
    throw new Error('NO_REFRESH_TOKEN: Microsoft no devolvió refresh_token.');
  }
  const email = data.id_token ? emailFromIdToken(data.id_token) : null;
  if (!email) throw new Error('NO_EMAIL: no pudimos leer el correo del id_token.');

  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    email,
    grantedScopes,
  };
}

/**
 * Renueva el access_token. Microsoft rota el refresh_token: devolvemos también el nuevo
 * para que el caller lo persista.
 */
export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: config.MICROSOFT_CLIENT_ID,
    client_secret: config.MICROSOFT_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES.join(' '),
  });
  const resp = await fetch(`${authBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MS refresh failed: ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token || refreshToken,
  };
}
