// Cliente de Skydropx (logística/paqueterías) para despachar los Cloud Speakers.
// Flujo: cotizar (rates por transportadora) → elegir rate_id → crear envío → guía PDF.
//
// Auth: OAuth2 client_credentials. POST /api/v1/oauth/token con client_id/secret →
// access_token Bearer que dura 7200s (2h). Cacheamos el token en memoria y lo
// refrescamos solo cuando va a expirar (los otros helpers de pasarela usan token
// estático del .env; Skydropx no, por eso este getToken()).
//
// ⚠️ Colombia: `postal_code` en las direcciones es el código DANE de 5 dígitos
// (Medellín 05001, Bogotá 11001), NO el código postal de 6. Además exige
// area_level1 (departamento) + area_level2 (ciudad) + declared_amount en la cotización.
//
// Host producción: api-pro.skydropx.com. Rate limit 2 req/seg.

import { config } from './config.js';

const SKY_API = 'https://api-pro.skydropx.com/api/v1';

// Caché del token en memoria (a nivel módulo). exp = epoch ms en que vence.
let cachedToken = { value: null, exp: 0 };

function ensureConfigured() {
  if (!config.hasSkydropx) {
    throw new Error('Skydropx no configurado (SKYDROPX_CLIENT_ID/SECRET)');
  }
}

/** Obtiene un access_token válido, reutilizando el cacheado hasta 60s antes de vencer. */
export async function getToken() {
  ensureConfigured();
  if (cachedToken.value && Date.now() < cachedToken.exp - 60_000) {
    return cachedToken.value;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.SKYDROPX_CLIENT_ID,
    client_secret: config.SKYDROPX_CLIENT_SECRET,
  });
  const resp = await fetch(`${SKY_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(`Skydropx token HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const ttl = Number(data.expires_in || 7200) * 1000;
  cachedToken = { value: data.access_token, exp: Date.now() + ttl };
  return cachedToken.value;
}

async function authHeaders(extra = {}) {
  const token = await getToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function skyRequest(method, path, body, attempt = 1) {
  ensureConfigured();
  const resp = await fetch(`${SKY_API}${path}`, {
    method,
    headers: await authHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // Reintentamos ante 429 (rate limit, 2 req/seg) y 5xx (hipos del server).
    // Los 422 son errores de validación reales (ej. ciudad sin cobertura) → NO reintentar.
    const retryable = resp.status === 429 || resp.status >= 500;
    if (retryable && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return skyRequest(method, path, body, attempt + 1);
    }
    const err = new Error(`Skydropx ${method} ${path} HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = resp.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ───────────────────────── Cotización ─────────────────────────

/**
 * Crea una cotización. La API es ASÍNCRONA: devuelve el id y rates sin precio;
 * hay que re-leer con getQuote() unos segundos después para traer total/days.
 * @param {object} p { fromPostal, fromDepto, fromCity, toPostal, toDepto, toCity, parcel:{length,width,height,weight}, declaredAmount, cashOnDelivery }
 * ⚠️ fromPostal/toPostal = CP postal de 6 dígitos (NO el DANE de 5). Con el DANE solo cotiza
 * Interrapidísimo y el envío rechaza el valor declarado; con el CP cotizan las 4 transportadoras.
 * declared_amount va DENTRO del parcel (como lo manda la web de Skydropx).
 * cashOnDelivery=true → contraentrega: la transportadora recauda el declared_amount al entregar.
 */
// Origen de la cotización/envío. Si hay un address_template_id configurado (un punto de
// recolección de la cuenta, ej. "Dispensario"), lo usamos: da MEJOR cobertura de
// transportadoras y destinos que un origen suelto. El declared_amount va en el parcel,
// así que el template ya NO rompe el valor declarado (ese bug era por mandarlo suelto).
function buildOrigin(p) {
  if (config.SKYDROPX_ORIGIN_TEMPLATE_ID) {
    return { address_template_id: config.SKYDROPX_ORIGIN_TEMPLATE_ID };
  }
  return {
    country_code: 'CO',
    postal_code: p.fromPostal,
    area_level1: p.fromDepto,
    area_level2: p.fromCity,
  };
}

export async function createQuotation(p) {
  const declared = Number(p.declaredAmount) || 50000;
  const payload = {
    quotation: {
      address_from: buildOrigin(p),
      address_to: {
        country_code: 'CO',
        postal_code: p.toPostal,
        area_level1: p.toDepto,
        area_level2: p.toCity,
      },
      parcels: [
        {
          length: Number(p.parcel.length),
          width: Number(p.parcel.width),
          height: Number(p.parcel.height),
          weight: Number(p.parcel.weight),
          package_type: p.packageType || '4G',
          package_content: p.packageContent || 'Dispositivo electronico',
          declared_amount: declared,
        },
      ],
      declared_amount: declared,
      ...(p.cashOnDelivery ? { cash_on_delivery: true } : {}),
    },
  };
  return skyRequest('POST', '/quotations', payload);
}

/** Re-lee una cotización por id (para traer los precios ya procesados). */
export async function getQuotation(id) {
  return skyRequest('GET', `/quotations/${id}`, null);
}

/**
 * Cotiza y espera (poll) a que las tarifas se resuelvan. Cada tarifa termina en uno
 * de dos estados: con precio (total != null) o `not_applicable` (no cubre ese paquete,
 * ej. servicios de carga que exigen >5kg/>8kg, o restricciones de la cuenta). La API es
 * asíncrona; poll hasta que TODAS estén resueltas o se agoten los intentos.
 * Devuelve { quotationId, rates } con SOLO las tarifas cotizables (con precio),
 * ordenadas de más barata a más cara, más `unavailable` (las descartadas, para diagnóstico).
 */
export async function quoteAndWait(p, { tries = 6, delayMs = 1500 } = {}) {
  // El CP de cada ciudad ya viene VALIDADO contra Skydropx (co-dane.js), así que no hace
  // falta fallback: el postal_code debería existir siempre.
  const created = await createQuotation(p);
  const id = created.id;
  let rates = [];
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const q = await getQuotation(id);
    rates = (q.rates || []).filter((r) => r && r.id);
    // Una tarifa está "resuelta" si ya tiene precio o quedó marcada not_applicable.
    const allResolved =
      rates.length > 0 && rates.every((r) => r.total != null || r.status === 'not_applicable');
    if (allResolved) break;
  }
  const available = rates
    .filter((r) => r.total != null)
    .map((r) => {
      const total = Number(r.total);
      // En contraentrega Skydropx cobra el flete (amount) + comisión de recaudo.
      // amount = flete base; total = lo que pagas. La diferencia es el costo del recaudo.
      const base = r.amount != null ? Number(r.amount) : total;
      const codFee = p.cashOnDelivery ? Math.max(0, Math.round((total - base) * 100) / 100) : 0;
      return {
        rateId: r.id,
        carrier: r.provider_name,
        service: r.provider_service_name,
        days: r.days ?? null,
        total,
        base,                 // flete sin recaudo
        codFee,               // comisión por recaudar (0 si no es contraentrega)
        cashOnDelivery: Boolean(p.cashOnDelivery),
        currency: r.currency || r.currency_code || 'COP',
      };
    })
    .sort((a, b) => a.total - b.total);
  const unavailable = rates
    .filter((r) => r.total == null)
    .map((r) => ({
      carrier: r.provider_name,
      service: r.provider_service_name,
      reason: Array.isArray(r.error)
        ? r.error[0]?.error_message
        : r.error?.error_message || null,
    }));
  return { quotationId: id, rates: available, unavailable };
}

// ───────────────────────── Envío (guía) ─────────────────────────

/**
 * Crea el envío con una tarifa elegida → reserva la guía con la transportadora.
 * @param {object} p { rateId, from:{name,company,street,postal,depto,city,phone,email}, to:{name,street,postal,depto,city,phone,email}, declaredAmount }
 * ⚠️ postal = CP de 6 dígitos (NO el DANE). declared_amount va en el parcel (por eso el
 * template origen ya NO rompe el valor declarado). El origen usa el address_template si está
 * configurado (mejor cobertura). Devuelve la respuesta cruda (label_url, tracking_number, etc.).
 */
export async function createShipment(p) {
  const declared = Number(p.declaredAmount) || 50000;
  // Origen: template (Dispensario) si está configurado, sino campos sueltos del remitente.
  const addressFrom = config.SKYDROPX_ORIGIN_TEMPLATE_ID
    ? { address_template_id: config.SKYDROPX_ORIGIN_TEMPLATE_ID }
    : {
        name: p.from.name,
        company: p.from.company || p.from.name,
        street1: p.from.street,
        postal_code: p.from.postal,
        area_level1: p.from.depto,
        area_level2: p.from.city,
        country_code: 'CO',
        phone: p.from.phone,
        email: p.from.email,
        reference: p.from.reference || 'Bodega',
      };
  const payload = {
    shipment: {
      rate_id: p.rateId,
      package_type: p.packageType || '4G',
      package_content: p.packageContent || 'Dispositivo electronico',
      parcels: [
        {
          length: Number(p.parcel?.length) || 17,
          width: Number(p.parcel?.width) || 10,
          height: Number(p.parcel?.height) || 4,
          weight: Number(p.parcel?.weight) || 1,
          package_type: p.packageType || '4G',
          package_content: p.packageContent || 'Dispositivo electronico',
          declared_amount: declared,
        },
      ],
      declared_amount: declared,
      address_from: addressFrom,
      address_to: {
        name: p.to.name,
        company: p.to.company || undefined,
        street1: p.to.street,
        postal_code: p.to.postal,
        area_level1: p.to.depto,
        area_level2: p.to.city,
        country_code: 'CO',
        phone: p.to.phone,
        email: p.to.email,
        reference: p.to.reference || 'Sin referencia',
      },
      ...(p.cashOnDelivery ? { cash_on_delivery: true } : {}),
    },
  };
  return skyRequest('POST', '/shipments', payload);
}

/** Recupera un envío por id. */
export async function getShipment(id) {
  return skyRequest('GET', `/shipments/${id}`, null);
}

/**
 * Cancela un envío en Skydropx (POST /shipments/{id}/cancellations).
 * La transportadora puede responder canceled / destroyed / retained. Devuelve la respuesta.
 * Si el envío ya no existe en Skydropx (ej. borrado a mano), Skydropx puede dar 404/422;
 * el llamador decide si igual borra la fila local.
 */
export async function cancelShipment(shipmentId, reason = 'Cancelado desde el panel Sono') {
  return skyRequest('POST', `/shipments/${shipmentId}/cancellations`, {
    reason,
    shipment_id: shipmentId,
  });
}

/** Baja el PDF de la guía (label_url) SERVER-SIDE con el token de API.
 * El navegador NO puede: la URL exige sesión/cookie y además Skydropx no manda CORS
 * para sono.lat. Acá lo bajamos con el Bearer (mismo dominio api-pro.skydropx.com) y
 * devolvemos los bytes crudos del PDF. */
export async function fetchLabelPdf(labelUrl) {
  ensureConfigured();
  const token = await getToken();
  const resp = await fetch(labelUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' },
  });
  if (!resp.ok) {
    const err = new Error(`Skydropx label PDF HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return Buffer.from(await resp.arrayBuffer());
}

/** Rastrea un envío por número de guía + transportadora. */
export async function trackShipment(trackingNumber, carrierName) {
  const qs = new URLSearchParams({ tracking_number: trackingNumber, carrier_name: carrierName });
  return skyRequest('GET', `/shipments/tracking?${qs.toString()}`, null);
}

// Normaliza la respuesta de Skydropx (create o GET shipment) a los campos que guardamos.
// La respuesta es JSON:API: { data: { id, attributes: {...} }, included: [{ type, attributes }] }.
// El label_url y tracking_number del paquete viven en included[type=package].attributes.
// El master_tracking_number y carrier en data.attributes. El label es asíncrono: puede no
// estar al crear y aparecer segundos después (por eso hay refreshShipment).
export function extractLabel(shipmentResponse) {
  const s = shipmentResponse || {};
  const data = s.data || s;
  const attrs = data.attributes || {};
  const included = Array.isArray(s.included) ? s.included : [];
  const pkg = included.find((x) => x.type === 'package')?.attributes || {};

  const labelUrl =
    attrs.label_url || pkg.label_url || s.label_url || null;
  const tracking =
    attrs.master_tracking_number || pkg.tracking_number || attrs.tracking_number ||
    s.master_tracking_number || s.tracking_number || null;
  const trackingUrl =
    pkg.tracking_url_provider || attrs.tracking_url_provider || null;
  const carrier =
    attrs.carrier_name || s.carrier_name || s.provider_name || null;
  const workflow = attrs.workflow_status || null; // 'success' cuando ya hay guía

  return {
    id: data.id || s.id || null,
    labelUrl,
    tracking,
    trackingUrl,
    carrier,
    workflow,
    raw: s,
  };
}
