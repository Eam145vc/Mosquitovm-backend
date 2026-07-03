// Rutas /admin para envíos con Skydropx (despachar el Cloud Speaker de una orden).
// Flujo: buscar ciudad (DANE) → cotizar → elegir tarifa → crear envío (guía PDF).
// Todas exigen el Bearer admin (mismo token que el resto de /admin/*).

import { config } from './config.js';
import { logger } from './logger.js';
import { searchCities, cityByDane } from './co-dane.js';
import { quoteAndWait, createShipment, getShipment, cancelShipment, extractLabel, fetchLabelPdf } from './skydropx.js';
import {
  getOrder, updateOrder,
  createShipmentRow, getShipmentByOrder, getShipmentRow, updateShipmentRow, listShipments, deleteShipment,
  getShipmentByTrackingOrId,
} from './storage.js';
import { enqueueEnvioIfReady, enqueueWhatsApp } from './wa-enqueue.js';

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

  // ──────────────────────── Webhook de tracking de Skydropx ────────────────────────
  // Skydropx (web → Conexiones > Webhooks, sección Envíos) hace POST acá en cada cambio
  // de estado del paquete: picked_up, in_transit, last_mile, delivery_attempt,
  // delivered, in_return, exception... Actualiza la fila del envío y encola los
  // WhatsApp al cliente: "en reparto" (last_mile, clave en COD para que tenga el
  // efectivo listo), "intento de entrega" (delivery_attempt, evita la devolución que
  // paga Sonó) y "entregado" (delivered, con el link de conectar el correo).
  // Auth: Bearer estático que genera Skydropx al crear el webhook (SKYDROPX_WEBHOOK_TOKEN).
  // Responde SIEMPRE 200 en errores de datos para que Skydropx no reintente en loop.
  app.post('/webhook/skydropx', async (req, reply) => {
    const token = config.SKYDROPX_WEBHOOK_TOKEN;
    if (token) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}` && auth !== token) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    } else {
      logger.warn('skydropx webhook: SKYDROPX_WEBHOOK_TOKEN vacío, aceptando sin validar');
    }
    try {
      const data = req.body?.data;
      // Solo procesamos eventos de paquete (los de orders/quotation/rate se ignoran).
      if (!data || data.type !== 'packages') return { ok: true, ignored: true };
      const attrs = data.attributes || {};
      const status = String(attrs.status || '');
      const trackingNumber = attrs.tracking_number || '';
      const shipmentUuid = data.relationships?.shipment?.data?.id || null;

      const row = getShipmentByTrackingOrId({ skydropxId: shipmentUuid, tracking: trackingNumber });
      if (!row) {
        logger.warn({ status, trackingNumber, shipmentUuid }, 'skydropx webhook: envío desconocido');
        return { ok: true, unknown: true };
      }

      const patch = {
        tracking_status: status,
        tracking_status_at: Date.now(),
        returned: attrs.returned ? 1 : 0,
        returned_status: attrs.returned_status || null,
      };
      if (!row.tracking && trackingNumber) patch.tracking = trackingNumber;
      if (!row.tracking_url && attrs.tracking_url_provider) patch.tracking_url = attrs.tracking_url_provider;
      updateShipmentRow(row.id, patch);

      const order = getOrder(row.order_id);
      if (order) {
        // El WhatsApp de la guía sale cuando la transportadora RECIBE el paquete
        // (picked_up/in_transit), no al imprimir la guía — así "va en camino" es real.
        // 'created' NO dispara (el paquete sigue en la bodega). last_mile incluido por
        // si la transportadora nunca reportó la recogida. Idempotente por (orden, kind).
        if (['picked_up', 'in_transit', 'last_mile'].includes(status)) {
          try { enqueueEnvioIfReady(order); } catch { /* nunca bloquea el webhook */ }
        }
        const kind = {
          last_mile: 'reparto',
          delivery_attempt: 'intento_entrega',
          delivered: 'entregado',
        }[status];
        if (kind) {
          try { enqueueWhatsApp(order, kind); }
          catch (e) { logger.error({ orderId: order.id, kind, err: e.message }, 'wa: aviso de tracking no encolado'); }
        }
      }
      // Devolución o excepción: no se le escribe al cliente; queda en nivel error para
      // que el dueño lo vea (logs/panel) y actúe — el flete del retorno lo paga Sonó.
      if (attrs.returned || status === 'in_return' || status === 'exception') {
        logger.error(
          { orderId: row.order_id, tracking: row.tracking || trackingNumber, status, returnedStatus: attrs.returned_status || null },
          'skydropx: envío en devolución/excepción — revisar'
        );
      }
      logger.info({ orderId: row.order_id, tracking: row.tracking || trackingNumber, status }, 'skydropx webhook: estado actualizado');
      return { ok: true };
    } catch (e) {
      logger.error({ err: e.message }, 'skydropx webhook error');
      return { ok: true };
    }
  });

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
    // Resolver destino: prioridad al DANE explícito del panel; luego el DANE que el
    // cliente eligió en el checkout (autocomplete, sin ambigüedad); al final, adivinar
    // por el texto de la ciudad (órdenes viejas con ciudad a mano).
    let dest = null;
    if (body.toDane) {
      dest = cityByDane(body.toDane) ||
        { dane: body.toDane, depto: body.toDepto || '', city: body.toCity || '' };
    } else if (order.city_dane) {
      dest = cityByDane(order.city_dane);
    }
    if (!dest && order.city) {
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
        fromDane: origin.dane,
        fromDepto: origin.depto,
        fromCity: origin.city,
        toPostal: dest.postal,
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
    const destPhone = to.phone || order.phone || config.SKYDROPX_ORIGIN_PHONE;
    const recipient = {
      name: to.name || order.business_name || 'Cliente',
      street: to.street || order.address || 'Sin dirección',
      postal: dest.postal,
      depto: dest.deptoApi || dest.depto,
      city: dest.cityApi || dest.city,
      phone: destPhone,
      email: to.email || order.customer_email || config.SKYDROPX_ORIGIN_EMAIL,
      // El teléfono va también en la referencia porque la plantilla de guía de Skydropx
      // NO imprime el campo `phone`, pero SÍ imprime `reference` (observaciones). Así el
      // mensajero ve el celular del destinatario en la etiqueta para coordinar la entrega.
      reference: to.reference || (destPhone ? `Tel ${destPhone}` : `Orden ${order.id}`),
    };
    const from = {
      name: config.SKYDROPX_ORIGIN_NAME,
      company: config.SKYDROPX_ORIGIN_NAME,
      street: config.SKYDROPX_ORIGIN_STREET || 'Bodega',
      postal: origin.postal,
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
        trackingUrl: label.trackingUrl,
        priceCents: body.priceCents ?? null,
        toDane: dest.dane,
        toCity: dest.city,
        status: label.labelUrl ? 'label_ready' : 'created',
      });
      // Marcar la orden como enviada (mismo estado que usa el flujo de despacho del admin).
      updateOrder(order.id, { status: 'shipped' });
      // El WhatsApp de la guía YA NO sale acá: se dispara cuando la transportadora
      // recoge el paquete (webhook picked_up/in_transit), con fallback a las 24h en
      // el waEnvioJob si la transportadora nunca reporta el evento.
      return { shipment: row, labelUrl: label.labelUrl, tracking: label.tracking };
    } catch (e) {
      return sendSkyError(reply, e);
    }
  });

  // ──────────────────────── Consultas ────────────────────────

  // Si el envío aún no tiene la guía (label asíncrono de Skydropx), la consulta en vivo
  // por su skydropx_id y actualiza la fila. Devuelve la fila (ya actualizada o como estaba).
  async function refreshShipment(row) {
    if (!row || !row.skydropx_id) return row;
    if (row.label_url && row.tracking) return row; // ya completa, nada que hacer
    if (!config.hasSkydropx) return row;
    try {
      const resp = await getShipment(row.skydropx_id);
      const label = extractLabel(resp);
      const patch = {};
      if (label.labelUrl && label.labelUrl !== row.label_url) patch.label_url = label.labelUrl;
      if (label.tracking && label.tracking !== row.tracking) patch.tracking = label.tracking;
      if (label.carrier && !row.carrier) patch.carrier = label.carrier;
      if (label.labelUrl && row.status !== 'label_ready') patch.status = 'label_ready';
      if (Object.keys(patch).length) {
        updateShipmentRow(row.id, patch);
        return getShipmentRow(row.id);
      }
    } catch {
      /* si Skydropx falla, devolvemos la fila como está (el panel reintenta luego) */
    }
    return row;
  }

  app.get('/admin/orders/:id/shipment', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const row = await refreshShipment(getShipmentByOrder(req.params.id));
    return { shipment: row };
  });

  // URL FRESCA de la guía para imprimir. La label_url de Skydropx es FIRMADA y CADUCA
  // (token con exp ~días); la que guardamos en la DB se muere y baja 404. Este endpoint
  // SIEMPRE re-consulta Skydropx por su id para obtener un label_url vivo, lo persiste y
  // lo devuelve. Lo usa el botón "Imprimir guía" justo antes de mandar al agente local.
  app.get('/admin/orders/:id/label-fresh', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const row = getShipmentByOrder(req.params.id);
    if (!row || !row.skydropx_id) return reply.code(404).send({ error: 'sin envío' });
    if (!config.hasSkydropx) return reply.code(503).send({ error: 'skydropx no configurado' });
    try {
      const label = extractLabel(await getShipment(row.skydropx_id));
      if (!label.labelUrl) return reply.code(409).send({ error: 'la guía aún no está lista' });
      // Persistir la URL fresca (la vieja ya caducó) para que el resto del panel también la use.
      if (label.labelUrl !== row.label_url) updateShipmentRow(row.id, { label_url: label.labelUrl });
      return { labelUrl: label.labelUrl };
    } catch (e) {
      req.log?.error?.({ err: e }, 'label-fresh falló');
      return reply.code(502).send({ error: 'no se pudo obtener la guía de Skydropx' });
    }
  });

  // EL PDF de la guía, bajado SERVER-SIDE (con el token de API). El navegador NO puede
  // bajarlo directo de Skydropx: la URL exige sesión/cookie y Skydropx no manda CORS para
  // sono.lat (bloqueado por CORS policy). Acá lo proxeamos: re-consultamos la URL fresca,
  // bajamos el PDF con el Bearer y lo devolvemos como binario al mismo origen (sin CORS).
  // Lo usa el botón "Imprimir guía" → manda el PDF al agente local que lo imprime.
  app.get('/admin/orders/:id/label-pdf', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const row = getShipmentByOrder(req.params.id);
    if (!row || !row.skydropx_id) return reply.code(404).send({ error: 'sin envío' });
    if (!config.hasSkydropx) return reply.code(503).send({ error: 'skydropx no configurado' });
    try {
      const label = extractLabel(await getShipment(row.skydropx_id));
      if (!label.labelUrl) return reply.code(409).send({ error: 'la guía aún no está lista' });
      if (label.labelUrl !== row.label_url) updateShipmentRow(row.id, { label_url: label.labelUrl });
      const pdf = await fetchLabelPdf(label.labelUrl);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="guia-${row.tracking || row.id}.pdf"`)
        .send(pdf);
    } catch (e) {
      req.log?.error?.({ err: e }, 'label-pdf falló');
      return reply.code(502).send({ error: 'no se pudo bajar la guía de Skydropx' });
    }
  });

  app.get('/admin/shipments', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    // Refresca las que aún no tengan guía (en paralelo, máx las primeras incompletas).
    const all = listShipments();
    const pending = all.filter((r) => !r.label_url && r.skydropx_id).slice(0, 10);
    await Promise.all(pending.map((r) => refreshShipment(r)));
    return { shipments: listShipments() };
  });

  // Borra un envío: intenta cancelarlo en Skydropx y elimina la fila local.
  // Si Skydropx ya no lo tiene (borrado a mano) o la cancelación falla, igual se borra
  // localmente (con ?force=1, o por defecto) para no dejar envíos fantasma en el panel.
  app.delete('/admin/shipments/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const row = getShipmentRow(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'envío no encontrado' });

    let skydropx = { canceled: false, detail: null };
    if (row.skydropx_id && config.hasSkydropx) {
      try {
        const resp = await cancelShipment(row.skydropx_id);
        skydropx = { canceled: true, detail: resp?.data?.attributes?.status || resp?.status || 'canceled' };
      } catch (e) {
        // 404/422 = ya no existe en Skydropx (borrado a mano) → seguimos y borramos local.
        skydropx = { canceled: false, detail: String(e?.message || e).slice(0, 200) };
        logger?.warn?.({ shipment: row.id, err: skydropx.detail }, 'no se pudo cancelar en Skydropx (se borra local igual)');
      }
    }
    deleteShipment(row.id);
    // Si la orden estaba marcada 'shipped' por este envío y no queda otro, la volvemos a paid.
    if (row.order_id && !getShipmentByOrder(row.order_id)) {
      const order = getOrder(row.order_id);
      if (order && order.status === 'shipped') updateOrder(row.order_id, { status: 'paid' });
    }
    return { ok: true, deleted: true, skydropx };
  });
}
