// Facturación electrónica DIAN (software propio, dian-kit).
//
// Cada venta pagada se factura ante la DIAN automáticamente:
//  - Con los datos del checkout si el cliente pidió factura a su nombre
//    (invoice_doc_type/number/name), o a CONSUMIDOR FINAL si no.
//  - Contado → forma de pago contado; cuotas → crédito con vencimiento a 60 días.
//  - El precio ya incluye IVA 19%: se desglosa base = total/1.19.
//
// El job (cada 5 min) toma órdenes pagadas sin invoice_number creadas después de
// FACTURACION_DESDE y las factura en serie. Kill-switch: FACTURACION_ENABLED=1.
// El XML firmado + metadatos quedan en <dataDir>/facturas/ (los sirve http-server
// en /factura/:order/*). Al facturar se le envía al cliente el correo con el link.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { listOrders, updateOrder, nextInvoiceNumber, rollbackInvoiceNumber, getOrder } from './storage.js';
import { cityByDane } from './co-dane.js';
import { esOrdenV2 } from './pricing.js';

const FACTURAS_DIR = path.join(path.dirname(config.DB_PATH), 'facturas');
fs.mkdirSync(FACTURAS_DIR, { recursive: true });

// Estados que cuentan como venta pagada (mismo criterio que http-server).
const PAID_STATES = ['paid', 'pendiente_qr', 'ready_to_ship', 'shipped'];

const IVA = 0.19;

let kit = null;          // DianKit singleton (carga el .p12 una sola vez)
let running = false;     // candado del job (no solapar corridas)

function habilitada() {
  return config.FACTURACION_ENABLED === '1'
    && config.DIAN_CERT_PATH
    && fs.existsSync(config.DIAN_CERT_PATH);
}

// Dígito de verificación de un NIT (algoritmo DIAN, pesos primos).
export function nitDv(nit) {
  const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const digits = String(nit).replace(/\D/g, '');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits[digits.length - 1 - i]) * pesos[i];
  }
  const r = sum % 11;
  return r <= 1 ? r : 11 - r;
}

async function getKit() {
  if (kit) return kit;
  const { DianKit } = await import('@dian-kit/sdk-node');
  const direccion = {
    street: 'Calle 42 # 80A-39',
    cityCode: '05001',
    cityName: 'Medellín',
    departmentCode: '05',
    departmentName: 'Antioquia',
    countryCode: 'CO',
    countryName: 'Colombia',
  };
  kit = new DianKit({
    certificate: fs.readFileSync(config.DIAN_CERT_PATH),
    certificatePassword: config.DIAN_CERT_PASSWORD,
    environment: config.DIAN_AMBIENTE,          // '1' producción | '2' habilitación
    supplier: {
      name: 'SONO TECH S.A.S',
      identification: { number: '902078586', type: '31', dv: '1' },
      personType: '1',
      fiscalResponsibilities: ['R-99-PN'],
      taxInfo: {
        registrationName: 'SONO TECH S.A.S',
        companyId: { number: '902078586', type: '31', dv: '1' },
        taxLevelCode: 'R-99-PN',
        taxScheme: { code: '01' },
        address: direccion,
      },
      address: direccion,
      email: 'facturas@sono.lat',
    },
    software: {
      id: config.DIAN_SOFTWARE_ID,
      pin: config.DIAN_SOFTWARE_PIN,
      providerNit: '902078586',
      providerName: 'SONO TECH S.A.S',
    },
    numbering: {
      authorizationNumber: config.DIAN_NUM_RESOLUCION,
      prefix: config.DIAN_NUM_PREFIJO,
      startNumber: Number(config.DIAN_NUM_DESDE),
      endNumber: Number(config.DIAN_NUM_HASTA),
      startDate: new Date(2026, 7, 3),   // 03-ago-2026 (mes 0-index)
      endDate: new Date(2028, 7, 3),
      technicalKey: config.DIAN_CLAVE_TECNICA,
    },
  });
  return kit;
}

// Adquirente: datos del checkout si pidió factura nominativa, sino consumidor final.
function buildCustomer(order, direccionEmisor) {
  const doc = order.invoice_doc_number;
  if (!doc) {
    return {
      name: 'CONSUMIDOR FINAL',
      identification: { number: '222222222222', type: '13' },
      personType: '2',
      fiscalResponsibilities: ['R-99-PN'],
      person: { firstName: 'CONSUMIDOR', familyName: 'FINAL' },
      taxInfo: {
        registrationName: 'CONSUMIDOR FINAL',
        companyId: { number: '222222222222', type: '13' },
        taxLevelCode: 'R-99-PN',
        taxScheme: { code: 'ZZ' },
        address: direccionEmisor,
      },
      address: direccionEmisor,
      email: order.customer_email || 'consumidor@sono.lat',
    };
  }
  const esNit = order.invoice_doc_type === 'NIT';
  const nombre = (order.invoice_name || order.business_name || 'CLIENTE').toUpperCase();
  const ciudad = order.city_dane ? cityByDane(order.city_dane) : null;
  const address = ciudad ? {
    street: order.address || 'No informada',
    cityCode: ciudad.dane,
    cityName: ciudad.city,
    departmentCode: ciudad.dane.slice(0, 2),
    departmentName: ciudad.depto,
    countryCode: 'CO',
    countryName: 'Colombia',
  } : direccionEmisor;
  const id = esNit
    ? { number: doc, type: '31', dv: String(nitDv(doc)) }
    : { number: doc, type: '13' };
  const partes = nombre.split(/\s+/);
  return {
    name: nombre,
    identification: id,
    personType: esNit ? '1' : '2',
    fiscalResponsibilities: ['R-99-PN'],
    ...(esNit ? {} : { person: { firstName: partes[0], familyName: partes.slice(1).join(' ') || partes[0] } }),
    taxInfo: {
      registrationName: nombre,
      companyId: id,
      taxLevelCode: 'R-99-PN',
      taxScheme: { code: 'ZZ' },
      address,
    },
    address,
    email: order.customer_email || 'consumidor@sono.lat',
  };
}

/**
 * Factura una orden pagada ante la DIAN. Idempotente: si ya tiene invoice_number
 * no hace nada. Devuelve { number, cufe } o null si no aplica/error.
 */
export async function facturarOrden(orderId) {
  const order = getOrder(orderId);
  if (!order || order.invoice_number) return null;
  if (!PAID_STATES.includes(order.status)) return null;

  const k = await getKit();
  const total = Math.round(order.amount_cents) / 100;
  const now = new Date();
  const esCuotas = order.plan === 'cuotas';
  const round2 = (n) => Math.round(n * 100) / 100;

  // ── Modelo v2 (procedimiento del contador, órdenes con términos v2): dos ítems.
  //    Equipo a precio de costo (gravado 19%) + servicio de computación en la nube
  //    por el resto del precio (EXCLUIDO de IVA, num. 21 art. 476 E.T.).
  const equipoCosto = Number(config.DIAN_EQUIPO_COSTO) || 0;
  const usaV2 = config.FACTURACION_MODELO === 'v2' && equipoCosto > 0 && esOrdenV2(order);
  // Una orden v2 NUNCA se factura con el modelo viejo (gravado total): si aún no está
  // definido el costo del equipo (lo da el contador), la orden ESPERA en la cola —
  // el job la retoma sola cuando DIAN_EQUIPO_COSTO exista en el .env.
  if (config.FACTURACION_MODELO === 'v2' && esOrdenV2(order) && !(equipoCosto > 0)) {
    logger.warn({ orderId }, 'facturación v2: falta DIAN_EQUIPO_COSTO — orden v2 en espera');
    return null;
  }

  let items;               // se guarda en el .json (reportes por ítem + PDF)
  let lines, taxTotals, legalMonetaryTotal, notes;
  if (usaV2) {
    const equipoIva = round2(equipoCosto * IVA);
    const servicio = round2(total - equipoCosto - equipoIva);
    if (servicio <= 0) {
      // El pago no alcanza a cubrir el equipo a costo + IVA (¿costo mal configurado?).
      logger.error({ orderId, total, equipoCosto }, 'facturación v2: el total no cubre equipo+IVA — orden SIN facturar');
      return null;
    }
    const descripcionServicio = esCuotas
      ? 'Servicio de computación en la nube para procesamiento e integración de pagos — Sonó, primer año (plan en 3 pagos)'
      : 'Anualidad servicio de computación en la nube para procesamiento e integración de pagos — Sonó';
    const equipoTax = {
      taxAmount: equipoIva,
      subtotals: [{ taxableAmount: equipoCosto, taxAmount: equipoIva, percent: 19, taxScheme: { code: '01' } }],
    };
    lines = [
      {
        id: '1', quantity: 1, unitCode: 'EA',
        description: 'Equipo altavoz Sonó (terminal de audio)',
        price: equipoCosto, lineExtensionAmount: equipoCosto,
        taxTotals: [equipoTax],
      },
      {
        id: '2', quantity: 1, unitCode: 'EA',
        description: descripcionServicio,
        price: servicio, lineExtensionAmount: servicio,
        taxTotals: [],                                   // excluido: sin IVA
      },
    ];
    taxTotals = [equipoTax];
    legalMonetaryTotal = {
      lineExtensionAmount: round2(equipoCosto + servicio),
      taxExclusiveAmount: round2(equipoCosto + servicio),
      taxInclusiveAmount: total,
      allowanceTotalAmount: 0,
      chargeTotalAmount: 0,
      prepaidAmount: 0,
      payableAmount: total,
    };
    notes = ['El servicio de computación en la nube se encuentra excluido de IVA de conformidad con el numeral 21 del artículo 476 del Estatuto Tributario.'];
    items = [
      { item: 'Equipo altavoz Sonó', bruto: equipoCosto, iva: equipoIva, total: round2(equipoCosto + equipoIva) },
      { item: descripcionServicio, bruto: servicio, iva: 0, excluido: true, total: servicio },
    ];
  } else {
    // ── Modelo v1 (lanzamiento): un ítem gravado, precio con IVA incluido.
    const base = round2(total / (1 + IVA));
    const iva = round2(total - base);
    const descripcion = esCuotas
      ? 'Sonó — anunciador de pagos QR (dispositivo + servicio, plan en cuotas)'
      : 'Sonó — anunciador de pagos QR (dispositivo + servicio, plan anual)';
    const taxTotal = {
      taxAmount: iva,
      subtotals: [{ taxableAmount: base, taxAmount: iva, percent: 19, taxScheme: { code: '01' } }],
    };
    lines = [{
      id: '1', quantity: 1, unitCode: 'EA',
      description: descripcion,
      price: base, lineExtensionAmount: base,
      taxTotals: [taxTotal],
    }];
    taxTotals = [taxTotal];
    legalMonetaryTotal = {
      lineExtensionAmount: base,
      taxExclusiveAmount: base,
      taxInclusiveAmount: total,
      allowanceTotalAmount: 0,
      chargeTotalAmount: 0,
      prepaidAmount: 0,
      payableAmount: total,
    };
    notes = undefined;
    items = [{ item: descripcion, bruto: base, iva, total }];
  }
  // Base gravable e IVA de la factura completa (para reportes y PDF).
  const base = round2(items.filter((i) => !i.excluido).reduce((s, i) => s + i.bruto, 0));
  const iva = round2(items.reduce((s, i) => s + i.iva, 0));

  const numero = nextInvoiceNumber();                       // consecutivo atómico (SQLite)
  const id = `${config.DIAN_NUM_PREFIJO}${numero}`;
  const descripcion = items.map((i) => i.item).join(' + ');

  const direccionEmisor = {
    street: 'Calle 42 # 80A-39', cityCode: '05001', cityName: 'Medellín',
    departmentCode: '05', departmentName: 'Antioquia', countryCode: 'CO', countryName: 'Colombia',
  };
  const customer = buildCustomer(order, direccionEmisor);

  const taxTotal = {
    taxAmount: iva,
    subtotals: [{ taxableAmount: base, taxAmount: iva, percent: 19, taxScheme: { code: '01' } }],
  };

  const factura = await k.createInvoice({
    id,
    issueDate: now,
    issueTime: now,
    customer,
    lines,
    taxTotals,
    legalMonetaryTotal,
    ...(notes ? { notes } : {}),
    paymentMeans: esCuotas
      ? { paymentForm: '2', paymentMethod: '30', dueDate: new Date(now.getTime() + 60 * 24 * 3600 * 1000) }
      : { paymentForm: '1', paymentMethod: '48' },
  });

  const resp = await k.send(factura);                        // SendBillSync (producción)
  if (!resp.isValid) {
    const errs = (resp.errors || []).map((e) => e.description || e).join(' | ');
    logger.error({ orderId, id, errs, status: resp.statusDescription }, 'facturación: DIAN rechazó la factura');
    rollbackInvoiceNumber(numero);                           // rechazada = el número nunca existió, se reusa
    return null;
  }

  const cufe = factura.uuid;
  fs.writeFileSync(path.join(FACTURAS_DIR, `${id}.xml`), factura.signedXml);
  fs.writeFileSync(path.join(FACTURAS_DIR, `${id}.json`), JSON.stringify({
    id, cufe, orderId, at: now.toISOString(),
    total, base, iva,
    modelo: usaV2 ? 'v2' : 'v1',
    items,                       // desglose por ítem (reportes del contador + PDF)
    ...(notes ? { notas: notes } : {}),
    customer: { name: customer.name, doc: customer.identification.number, type: customer.identification.type },
    descripcion, plan: order.plan || 'contado',
  }, null, 2));
  updateOrder(orderId, { invoice_number: id, invoice_cufe: cufe, invoice_at: Date.now() });
  logger.info({ orderId, factura: id, cufe: cufe.slice(0, 12) }, 'facturación: factura emitida y aceptada por la DIAN');

  enviarCorreoFactura(getOrder(orderId)).catch((e) =>
    logger.error({ orderId, err: e.message }, 'facturación: no se pudo enviar el correo'));
  return { number: id, cufe };
}

// Correo al cliente con el link de descarga (PDF + XML). Mismo MX saliente del buzón.
async function enviarCorreoFactura(order) {
  const to = order.customer_email || order.mp_payer_email;
  if (!to || !config.MX_SEND_API_URL || !config.EMAIL_WEBHOOK_SECRET) return false;
  const base = (config.FRONTEND_BASE_URL || 'https://sono.lat').replace(/\/$/, '');
  const api = (config.PUBLIC_API_BASE || 'https://api.sono.lat').replace(/\/$/, '');
  const pdf = `${api}/factura/${order.id}/pdf`;
  const xml = `${api}/factura/${order.id}/xml`;
  const total = (order.amount_cents / 100).toLocaleString('es-CO');

  const text = [
    'Hola,',
    '',
    `Te compartimos la factura electrónica ${order.invoice_number} de tu compra en Sonó por $${total}.`,
    '',
    `Descargar factura (PDF): ${pdf}`,
    `XML (validación DIAN): ${xml}`,
    '',
    `CUFE: ${order.invoice_cufe}`,
    '',
    'El equipo de Sonó — sono.lat',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f4f4ef;font-family:Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;">
      <tr><td style="padding:26px 28px 6px;"><span style="font-size:20px;font-weight:bold;color:#0a0f1f;">Tu factura electrónica</span></td></tr>
      <tr><td style="padding:6px 28px 0;">
        <p style="margin:0 0 14px;font-size:14px;color:#374050;line-height:1.55;">
          Gracias por tu compra. Esta es la factura <b>${order.invoice_number}</b> por <b>$${total}</b>,
          validada ante la DIAN.</p>
        <p style="margin:0 0 20px;"><a href="${pdf}" style="display:inline-block;background:#18a848;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:999px;">Descargar factura (PDF)</a></p>
        <p style="margin:0 0 16px;font-size:12px;color:#4a5168;">También puedes descargar el <a href="${xml}" style="color:#0d8a36;">XML firmado</a> (validación DIAN).<br>
        CUFE: <span style="font-size:10px;word-break:break-all;">${order.invoice_cufe}</span></p>
      </td></tr>
      <tr><td style="padding:18px 28px;border-top:1px solid #0a0f1f0f;">
        <p style="margin:0;font-size:13px;color:#4a5168;">Sono Tech S.A.S — NIT 902078586-1<br><a href="${base}" style="color:#0d8a36;text-decoration:none;">sono.lat</a></p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;

  const resp = await fetch(`${config.MX_SEND_API_URL.replace(/\/$/, '')}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sono-secret': config.EMAIL_WEBHOOK_SECRET },
    body: JSON.stringify({
      fromLocal: 'facturas',
      fromName: 'Sonó Facturación',
      to,
      subject: `Factura electrónica ${order.invoice_number} — Sonó`,
      text, html,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    logger.error({ orderId: order.id, status: resp.status }, 'facturación: MX rechazó el correo de la factura');
    return false;
  }
  logger.info({ orderId: order.id, to }, 'facturación: correo de factura enviado');
  return true;
}

/** Job periódico: factura las ventas pagadas sin factura (desde FACTURACION_DESDE). */
export async function runFacturacionJob() {
  if (!habilitada() || running) return;
  running = true;
  try {
    const desde = Number(config.FACTURACION_DESDE) || 0;
    const pendientes = listOrders().filter((o) =>
      PAID_STATES.includes(o.status)
      && !o.invoice_number
      && !o.archived_at
      && o.created_at >= desde);
    for (const o of pendientes) {
      try {
        await facturarOrden(o.id);
      } catch (e) {
        logger.error({ orderId: o.id, err: e.message }, 'facturación: error facturando la orden (se reintenta en el próximo ciclo)');
      }
    }
  } finally {
    running = false;
  }
}

export { FACTURAS_DIR };
