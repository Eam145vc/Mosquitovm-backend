// Rutas /admin para envíos con Skydropx (despachar el Cloud Speaker de una orden).
// Flujo: buscar ciudad (DANE) → cotizar → elegir tarifa → crear envío (guía PDF).
// Todas exigen el Bearer admin (mismo token que el resto de /admin/*).

import { config } from './config.js';
import { searchCities, cityByDane } from './co-dane.js';
import { quoteAndWait, createShipment, extractLabel } from './skydropx.js';
import {
  getOrder, updateOrder,
  createShipmentRow, getShipmentByOrder, updateShipmentRow, listShipments,
} from './storage.js';

// Paquete por defecto del Cloud Speaker en su caja (editable por envío desde el admin).
const DEFAULT_PARCEL = { length: 17, width: 10, height: 4, weight: 1 };
// Contenido declarado del paquete (obligatorio al crear el envío).
const PACKAGE_CONTENT = 'Altavoz IoT (dispositivo electronico)';

// Origen del despacho (bodega). El CP postal de 6 dígitos se resuelve del catálogo por DANE
// (Skydropx necesita el CP, no el DANE). Fallback a la env var si el DANE no está en el catálogo.
function originAddress() {
  const c = cityByDane(config.SKYDROPX_ORIGIN_DANE);
  return {
    postal: c?.postal || config.SKYDROPX_ORIGIN_POSTAL,
    postalAlt: c?.postalAlt || null,
    // area_level1/2 para la API: sin tildes, mayúsculas (la API rompe con tildes).
    depto: c?.deptoApi || config.SKYDROPX_ORIGIN_DEPTO,
    city: c?.cityApi || config.SKYDROPX_ORIGIN_CITY,
    dane: config.SKYDROPX_ORIGIN_DANE,
  };
}

export function registerSkydropxRoutes(app) {
  const requireAdmin = (req, reply) => {
    if (!config.ADMIN_TOKEN) { reply.code(503).send({ error: 'admin disabled' }); return false; }
    if ((req.headers.authorization || '') !== `Bearer ${config.ADMIN_TOKEN}`) {
      reply.code(401).send({ error: 'unauthorized' }); return false;
    }
    return true;
  };

  const guardConfigured = (reply) => {
    if (!config.hasSkydropx) {
      reply.code(503).send({ error: 'Skydropx no configurado (SKYDROPX_CLIENT_ID/SECRET)' });
      return false;
    }
    return true;
  };

  // Convierte un error del cliente Skydropx en una respuesta HTTP entendible.
  const sendSkyError = (reply, e) => {
    const status = e?.status === 422 ? 422 : 502;
    const msg =
      e?.status === 422
        ? 'Datos del envío inválidos (revisa ciudad destino y medidas)'
        : 'Error comunicándose con Skydropx';
    reply.code(status).send({ error: msg, detail: String(e?.message || e).slice(0, 300) });
  };

  // ──────────────────────── Buscador de ciudad (DANE) ────────────────────────

  app.get('/admin/cities', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const q = String(req.query?.q || '').trim();
    return { cities: q.length >= 2 ? searchCities(q, 10) : [] };
  });

  // ──────────────────────── Cotizar el envío de una orden ────────────────────────
  // Body: { toDane, toCity?, toDepto?, parcel?:{length,width,height,weight} }
  // Si no mandan toDane se intenta resolver desde order.city con el catálogo.

  app.post('/admin/orders/:id/quote', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!guardConfigured(reply)) return;
    const order = getOrder(req.params.id);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });

    const body = req.body || {};
    // Resolver destino: prioridad al DANE explícito; si no, buscar por la ciudad de la orden.
    let dest = null;
    if (body.toDane) {
      dest = cityByDane(body.toDane) ||
        { dane: body.toDane, depto: body.toDepto || '', city: body.toCity || '' };
    } else if (order.city) {
      dest = searchCities(order.city, 1)[0] || null;
    }
    if (!dest || !dest.dane) {
      return reply.code(400).send({ error: 'No se pudo resolver la ciudad destino. Busca y elige una ciudad.' });
    }

    const parcel = { ...DEFAULT_PARCEL, ...(body.parcel || {}) };
    const declaredAmount = order.amount_cents ? Math.round(order.amount_cents / 100) : 50000;
    // Contraentrega: por defecto se decide según el pedido (order.delivery), pero el body
    // puede forzarlo (toggle del panel). En COD la transportadora recauda el declaredAmount.
    const cashOnDelivery =
      typeof body.cashOnDelivery === 'boolean'
        ? body.cashOnDelivery
        : order.delivery === 'contraentrega';

    const origin = originAddress();
    try {
      const result = await quoteAndWait({
        fromPostal: origin.postal,
        fromPostalAlt: origin.postalAlt,
        fromDane: origin.dane,
        fromDepto: origin.depto,
        fromCity: origin.city,
        toPostal: dest.postal,
        toPostalAlt: dest.postalAlt,
        toDane: dest.dane,
        toDepto: dest.deptoApi || dest.depto,
        toCity: dest.cityApi || dest.city,
        parcel,
        declaredAmount,
        cashOnDelivery,
        packageContent: PACKAGE_CONTENT,
      });
      return {
        quotationId: result.quotationId,
        rates: result.rates,
        unavailable: result.unavailable,
        dest,
        parcel,
        cashOnDelivery,
        declaredAmount,
      };
    } catch (e) {
      return sendSkyError(reply, e);
    }
  });

  // ──────────────────────── Crear el envío (genera la guía) ────────────────────────
  // Body: { rateId, quotationId?, toDane, toCity, toDepto, to:{name?,street?,phone?,email?,reference?} }

  app.post('/admin/orders/:id/shipment', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!guardConfigured(reply)) return;
    const order = getOrder(req.params.id);
    if (!order) return reply.code(404).send({ error: 'orden no encontrada' });

    const body = req.body || {};
    if (!body.rateId) return reply.code(400).send({ error: 'falta rateId (elige una tarifa)' });

    const dest = body.toDane
      ? (cityByDane(body.toDane) || { dane: body.toDane, depto: body.toDepto || '', city: body.toCity || '' })
      : null;
    if (!dest || !dest.dane) return reply.code(400).send({ error: 'falta ciudad destino (DANE)' });

    const origin = originAddress();
    const to = body.to || {};
    const recipient = {
      name: to.name || order.business_name || 'Cliente',
      street: to.street || order.address || 'Sin dirección',
      postal: dest.postal,
      postalAlt: dest.postalAlt,
      depto: dest.deptoApi || dest.depto,
      city: dest.cityApi || dest.city,
      phone: to.phone || order.phone || config.SKYDROPX_ORIGIN_PHONE,
      email: to.email || order.customer_email || config.SKYDROPX_ORIGIN_EMAIL,
      reference: to.reference || `Orden ${order.id}`,
    };
    const from = {
      name: config.SKYDROPX_ORIGIN_NAME,
      company: config.SKYDROPX_ORIGIN_NAME,
      street: config.SKYDROPX_ORIGIN_STREET || 'Bodega',
      postal: origin.postal,
      postalAlt: origin.postalAlt,
      depto: origin.depto,
      city: origin.city,
      phone: config.SKYDROPX_ORIGIN_PHONE,
      email: config.SKYDROPX_ORIGIN_EMAIL,
    };

    // Contraentrega: del body (toggle) o derivado del pedido.
    const cashOnDelivery =
      typeof body.cashOnDelivery === 'boolean'
        ? body.cashOnDelivery
        : order.delivery === 'contraentrega';
    // Valor declarado (obligatorio al crear el envío). En contraentrega es lo que se recauda.
    const declaredAmount = order.amount_cents ? Math.round(order.amount_cents / 100) : 50000;
    const parcel = { ...DEFAULT_PARCEL, ...(body.parcel || {}) };

    try {
      const resp = await createShipment({
        rateId: body.rateId,
        from,
        to: recipient,
        parcel,
        cashOnDelivery,
        declaredAmount,
        packageContent: PACKAGE_CONTENT,
      });
      const label = extractLabel(resp);
      const row = createShipmentRow({
        orderId: order.id,
        skydropxId: label.id,
        quotationId: body.quotationId || null,
        rateId: body.rateId,
        carrier: label.carrier || body.carrier || null,
        service: body.service || null,
        tracking: label.tracking,
        labelUrl: label.labelUrl,
        priceCents: body.priceCents ?? null,
        toDane: dest.dane,
        toCity: dest.city,
        status: label.labelUrl ? 'label_ready' : 'created',
      });
      // Marcar la orden como enviada (mismo estado que usa el flujo de despacho del admin).
      updateOrder(order.id, { status: 'shipped' });
      return { shipment: row, labelUrl: label.labelUrl, tracking: label.tracking };
    } catch (e) {
      return sendSkyError(reply, e);
    }
  });

  // ──────────────────────── Consultas ────────────────────────

  app.get('/admin/orders/:id/shipment', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { shipment: getShipmentByOrder(req.params.id) };
  });

  app.get('/admin/shipments', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { shipments: listShipments() };
  });
}
