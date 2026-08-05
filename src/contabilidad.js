// Módulo contable: la vista de la empresa para el contador.
//
// Fuente de verdad: las facturas emitidas y aceptadas por la DIAN (facturacion.js
// deja <id>.xml + <id>.json en FACTURAS_DIR y marca la orden con invoice_number).
// Este módulo las agrega por período fiscal (mes / bimestre DIAN, TZ Bogotá) y las
// exporta en todos los formatos que un contador pide: Excel (libro de ventas +
// resumen de IVA), CSV y ZIP con los XML firmados + PDFs.
//
// Acceso: rol 'contador' (solo /admin/conta/*) o el dueño. Las descargas también
// aceptan un token HMAC firmado (?t=) para los links del correo mensual, que se
// envía solo al CONTADOR_EMAIL configurado.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { listOrders } from './storage.js';
import { FACTURAS_DIR } from './facturacion.js';

const IVA_PCT = 19;
// Bogotá es UTC-5 sin horario de verano: basta un corrimiento fijo.
const BOG_MS = 5 * 3600 * 1000;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const cop = (n) => `$${Number(n).toLocaleString('es-CO', { maximumFractionDigits: 2 })}`;

// ── Fechas (todas en calendario Bogotá) ─────────────────────────────────────

/** 'YYYY-MM-DD' (día Bogotá) → epoch ms del inicio de ese día. */
export function dayStartMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + BOG_MS;
}

/** Partes de calendario Bogotá de un epoch ms. */
function bogota(ms) {
  const d = new Date(ms - BOG_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() };
}

const pad2 = (n) => String(n).padStart(2, '0');
const isoDay = (ms) => { const b = bogota(ms); return `${b.y}-${pad2(b.m + 1)}-${pad2(b.day)}`; };

// ── Facturas del período ────────────────────────────────────────────────────

/**
 * Facturas emitidas con invoice_at en [desdeMs, hastaMs). Los montos salen del
 * .json que dejó facturacion.js (base/iva exactos de la factura); si falta, se
 * recalculan de la orden. Ordenadas por número.
 */
export function listFacturas(desdeMs, hastaMs) {
  const rows = [];
  // listOrders trae TODAS (archivadas incluidas): una factura emitida es un hecho
  // fiscal — archivar la orden no la saca del libro de ventas.
  for (const o of listOrders()) {
    if (!o.invoice_number || !o.invoice_at) continue;
    if (o.invoice_at < desdeMs || o.invoice_at >= hastaMs) continue;
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(FACTURAS_DIR, `${o.invoice_number}.json`), 'utf8'));
    } catch { /* sin json: se recalcula de la orden */ }
    const total = meta?.total ?? Math.round(o.amount_cents) / 100;
    const base = meta?.base ?? Math.round((total / (1 + IVA_PCT / 100)) * 100) / 100;
    const iva = meta?.iva ?? Math.round((total - base) * 100) / 100;
    rows.push({
      numero: o.invoice_number,
      cufe: o.invoice_cufe || meta?.cufe || '',
      fecha: isoDay(o.invoice_at),
      at: o.invoice_at,
      orderId: o.id,
      cliente: meta?.customer?.name || o.invoice_name || 'CONSUMIDOR FINAL',
      doc: meta?.customer?.doc || o.invoice_doc_number || '222222222222',
      docType: o.invoice_doc_type || (o.invoice_doc_number ? 'CC' : 'CF'),
      plan: o.plan || meta?.plan || 'contado',
      descripcion: meta?.descripcion || '',
      modelo: meta?.modelo || 'v1',
      // Desglose por ítem (facturas v2: equipo gravado + servicio excluido; las v1
      // traen un solo ítem). El reporte del contador se arma línea por ítem.
      items: (Array.isArray(meta?.items) && meta.items.length)
        ? meta.items
        : [{ item: meta?.descripcion || 'Sonó — dispositivo + servicio', bruto: base, iva, total }],
      base, iva, total,
    });
  }
  rows.sort((a, b) => Number(a.numero.replace(/\D/g, '')) - Number(b.numero.replace(/\D/g, '')));
  return rows;
}

export function kpis(rows) {
  const sum = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) * 100) / 100;
  return {
    facturas: rows.length,
    base: sum('base'),
    iva: sum('iva'),
    total: sum('total'),
    ticket: rows.length ? Math.round(sum('total') / rows.length) : 0,
    nominativas: rows.filter((r) => r.docType !== 'CF').length,
  };
}

/** Resumen del año: por mes y por bimestre DIAN (períodos del formulario 300). */
export function resumenYear(year) {
  const desde = Date.UTC(year, 0, 1) + BOG_MS;
  const hasta = Date.UTC(year + 1, 0, 1) + BOG_MS;
  const rows = listFacturas(desde, hasta);
  const meses = MESES.map((nombre, i) => {
    const del = rows.filter((r) => bogota(r.at).m === i);
    return { mes: i + 1, nombre, ...kpis(del) };
  });
  const bimestres = [0, 1, 2, 3, 4, 5].map((b) => {
    const m1 = meses[b * 2], m2 = meses[b * 2 + 1];
    return {
      bimestre: b + 1,
      nombre: `${MESES[b * 2]} – ${MESES[b * 2 + 1]}`,
      facturas: m1.facturas + m2.facturas,
      base: Math.round((m1.base + m2.base) * 100) / 100,
      iva: Math.round((m1.iva + m2.iva) * 100) / 100,
      total: Math.round((m1.total + m2.total) * 100) / 100,
    };
  });
  return { year, meses, bimestres, total: kpis(rows) };
}

// ── Exportes ────────────────────────────────────────────────────────────────

/** CSV es-CO por ÍTEM (formato del contador: fecha, factura, documento, ítem, bruto,
 *  IVA, retenciones, neto). Separador ';', decimales con coma, BOM para Excel. */
export function libroCsv(rows) {
  const num = (n) => String(Number(n).toFixed(2)).replace('.', ',');
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ['Fecha;Factura;Cliente;Tipo doc;Documento;Plan;Ítem;Valor bruto;IVA;Retenciones;Valor neto;CUFE'];
  let tBruto = 0, tIva = 0;
  for (const r of rows) {
    for (const it of r.items) {
      // Retenciones: van en 0 — las practica el COMPRADOR cuando aplica (B2B); la
      // columna existe para que el contador la concilie con los certificados.
      const neto = Math.round((it.bruto + it.iva) * 100) / 100;
      tBruto += it.bruto; tIva += it.iva;
      lines.push([r.fecha, r.numero, esc(r.cliente), r.docType, r.doc, r.plan, esc(it.item),
        num(it.bruto), num(it.iva), num(0), num(neto), r.cufe].join(';'));
    }
  }
  lines.push(['TOTAL', '', '', '', '', '', '', num(tBruto), num(tIva), num(0), num(tBruto + tIva), ''].join(';'));
  return '﻿' + lines.join('\r\n');
}

/** Excel con dos hojas: Libro de ventas + Resumen IVA (mes y bimestre DIAN). */
export async function libroXlsx(rows, desdeMs, hastaMs) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sonó — Sono Tech S.A.S';
  const VERDE = 'FF18A848';
  const money = '"$"#,##0.00';

  const styleHeader = (ws) => {
    const h = ws.getRow(1);
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERDE } };
    h.height = 20;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  // Libro de ventas POR ÍTEM (formato del contador): una fila por ítem de factura,
  // con retenciones (en 0, las practica el comprador cuando aplica) y valor neto.
  const ws = wb.addWorksheet('Libro de ventas');
  ws.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Factura', key: 'numero', width: 11 },
    { header: 'Cliente', key: 'cliente', width: 30 },
    { header: 'Tipo', key: 'docType', width: 7 },
    { header: 'Documento', key: 'doc', width: 15 },
    { header: 'Ítem', key: 'item', width: 52 },
    { header: 'Valor bruto', key: 'bruto', width: 14, style: { numFmt: money } },
    { header: 'IVA', key: 'ivaItem', width: 12, style: { numFmt: money } },
    { header: 'Retenciones', key: 'ret', width: 12, style: { numFmt: money } },
    { header: 'Valor neto', key: 'neto', width: 14, style: { numFmt: money } },
    { header: 'CUFE', key: 'cufe', width: 50 },
  ];
  let tBruto = 0, tIva = 0;
  for (const r of rows) {
    for (const it of r.items) {
      tBruto += it.bruto; tIva += it.iva;
      ws.addRow({
        fecha: r.fecha, numero: r.numero, cliente: r.cliente, docType: r.docType, doc: r.doc,
        item: it.item, bruto: it.bruto, ivaItem: it.iva, ret: 0,
        neto: Math.round((it.bruto + it.iva) * 100) / 100, cufe: r.cufe,
      });
    }
  }
  const tr = ws.addRow({ fecha: 'TOTAL', bruto: tBruto, ivaItem: tIva, ret: 0, neto: Math.round((tBruto + tIva) * 100) / 100 });
  tr.font = { bold: true };
  styleHeader(ws);

  const year = bogota(desdeMs).y;
  const res = resumenYear(year);
  const ws2 = wb.addWorksheet('Resumen IVA');
  ws2.columns = [
    { header: `Período ${year}`, key: 'nombre', width: 26 },
    { header: 'Facturas', key: 'facturas', width: 10 },
    { header: 'Base gravable', key: 'base', width: 16, style: { numFmt: money } },
    { header: 'IVA generado', key: 'iva', width: 15, style: { numFmt: money } },
    { header: 'Total facturado', key: 'total', width: 16, style: { numFmt: money } },
  ];
  res.meses.filter((m) => m.facturas > 0).forEach((m) => ws2.addRow(m));
  ws2.addRow({});
  res.bimestres.forEach((b) => {
    const r = ws2.addRow({ ...b, nombre: `Bimestre ${b.bimestre} (${b.nombre})` });
    if (b.facturas > 0) r.font = { bold: true };
  });
  const t2 = ws2.addRow({ nombre: `TOTAL ${year}`, ...res.total });
  t2.font = { bold: true };
  styleHeader(ws2);

  // Catálogo de clientes del período (información exógena): identificación,
  // dirección, ciudad, teléfono y correo de cada cliente facturado.
  const ws3 = wb.addWorksheet('Clientes');
  ws3.columns = [
    { header: 'Razón social / Nombre', key: 'nombre', width: 32 },
    { header: 'Tipo', key: 'tipo', width: 7 },
    { header: 'Identificación', key: 'doc', width: 16 },
    { header: 'Dirección', key: 'dir', width: 34 },
    { header: 'Ciudad', key: 'ciudad', width: 18 },
    { header: 'Teléfono', key: 'tel', width: 14 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Facturas', key: 'facturas', width: 22 },
  ];
  const porOrden = new Map(listOrders().map((o) => [o.id, o]));
  const clientes = new Map();     // doc+nombre → fila acumulada (facturas del período)
  for (const r of rows) {
    const o = porOrden.get(r.orderId) || {};
    const key = `${r.doc}|${r.cliente}`;
    const prev = clientes.get(key);
    if (prev) { prev.facturas += `, ${r.numero}`; continue; }
    clientes.set(key, {
      nombre: r.cliente, tipo: r.docType, doc: r.doc,
      dir: o.address || '', ciudad: o.city || '', tel: o.phone || '',
      email: o.customer_email || o.mp_payer_email || '', facturas: r.numero,
    });
  }
  clientes.forEach((c) => ws3.addRow(c));
  styleHeader(ws3);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** ZIP del período: XML firmado + PDF de cada factura + libro CSV. */
export async function paqueteZip(rows) {
  const { default: AdmZip } = await import('adm-zip');
  const { facturaPdf } = await import('./factura-pdf.js');
  const zip = new AdmZip();
  for (const r of rows) {
    const xmlPath = path.join(FACTURAS_DIR, `${r.numero}.xml`);
    if (fs.existsSync(xmlPath)) zip.addFile(`xml/${r.numero}.xml`, fs.readFileSync(xmlPath));
    const pdf = await facturaPdf(r.numero).catch(() => null);
    if (pdf) zip.addFile(`pdf/${r.numero}.pdf`, pdf);
  }
  zip.addFile('libro-ventas.csv', Buffer.from(libroCsv(rows), 'utf8'));
  return zip.toBuffer();
}

// ── Token firmado para links de descarga (correo mensual, sin login) ────────

export function signDownload(kind, desde, hasta) {
  return crypto.createHmac('sha256', config.ENCRYPTION_KEY)
    .update(`conta:${kind}:${desde}:${hasta}`).digest('hex');
}

export function verifyDownload(kind, desde, hasta, t) {
  const good = signDownload(kind, desde, hasta);
  const bt = Buffer.from(String(t || ''));
  const bg = Buffer.from(good);
  return bt.length === bg.length && crypto.timingSafeEqual(bt, bg);
}

// ── Correo mensual al contador ──────────────────────────────────────────────

const MAIL_STATE = () => path.join(path.dirname(config.DB_PATH), 'conta-mail.json');

/**
 * El día 1 (con reintentos hasta el día 5) le envía al contador el paquete del
 * mes anterior: KPIs en el cuerpo + links firmados a Excel, CSV y ZIP. Solo si
 * hay CONTADOR_EMAIL y hubo facturas ese mes. Idempotente por mes (archivo estado).
 */
export async function runContaMailJob() {
  if (!config.CONTADOR_EMAIL || !config.MX_SEND_API_URL || !config.EMAIL_WEBHOOK_SECRET) return;
  const hoy = bogota(Date.now());
  if (hoy.day > 5) return;
  const prevY = hoy.m === 0 ? hoy.y - 1 : hoy.y;
  const prevM = hoy.m === 0 ? 11 : hoy.m - 1;
  const mesKey = `${prevY}-${pad2(prevM + 1)}`;

  let state = {};
  try { state = JSON.parse(fs.readFileSync(MAIL_STATE(), 'utf8')); } catch { /* primera vez */ }
  if (state.lastSent === mesKey) return;

  const desdeMs = Date.UTC(prevY, prevM, 1) + BOG_MS;
  const hastaMs = Date.UTC(prevM === 11 ? prevY + 1 : prevY, (prevM + 1) % 12, 1) + BOG_MS;
  const rows = listFacturas(desdeMs, hastaMs);
  if (!rows.length) return;

  const desde = isoDay(desdeMs);
  const hasta = isoDay(hastaMs - 1);
  const api = (config.PUBLIC_API_BASE || 'https://api.sono.lat').replace(/\/$/, '');
  const link = (kind) =>
    `${api}/admin/conta/export?kind=${kind}&desde=${desde}&hasta=${hasta}&t=${signDownload(kind, desde, hasta)}`;
  const k = kpis(rows);
  const mesNombre = `${MESES[prevM]} ${prevY}`;

  const text = [
    'Hola,',
    '',
    `Este es el paquete contable de Sonó de ${mesNombre}:`,
    '',
    `Facturas emitidas: ${k.facturas} (${k.nominativas} nominativas)`,
    `Base gravable: ${cop(k.base)}`,
    `IVA generado (19%): ${cop(k.iva)}`,
    `Total facturado: ${cop(k.total)}`,
    '',
    `Excel (libro de ventas + resumen IVA): ${link('xlsx')}`,
    `CSV: ${link('csv')}`,
    `ZIP (XML firmados DIAN + PDFs): ${link('zip')}`,
    '',
    'También puedes entrar al panel con tu usuario: https://sono.lat/admin',
    '',
    'Sono Tech S.A.S — NIT 902078586-1',
  ].join('\n');

  const resp = await fetch(`${config.MX_SEND_API_URL.replace(/\/$/, '')}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sono-secret': config.EMAIL_WEBHOOK_SECRET },
    body: JSON.stringify({
      fromLocal: 'facturas',
      fromName: 'Sonó Contabilidad',
      to: config.CONTADOR_EMAIL,
      subject: `Paquete contable Sonó — ${mesNombre}`,
      text,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    logger.error({ status: resp.status }, 'conta: MX rechazó el correo mensual (se reintenta mañana)');
    return;
  }
  fs.writeFileSync(MAIL_STATE(), JSON.stringify({ lastSent: mesKey }));
  logger.info({ mes: mesKey, to: config.CONTADOR_EMAIL, facturas: k.facturas }, 'conta: paquete mensual enviado al contador');
}

// ── Rutas ───────────────────────────────────────────────────────────────────

export function registerContaRoutes(app, requireConta) {
  // Rango pedido → [desdeMs, hastaMs). `hasta` es inclusivo (día completo).
  const parseRange = (q) => {
    const desdeMs = dayStartMs(q?.desde);
    const hastaMs = dayStartMs(q?.hasta);
    if (desdeMs == null || hastaMs == null) return null;
    return { desdeMs, hastaMs: hastaMs + 24 * 3600 * 1000, desde: q.desde, hasta: q.hasta };
  };

  app.get('/admin/conta/facturas', async (req, reply) => {
    if (!requireConta(req, reply)) return;
    const r = parseRange(req.query);
    if (!r) return reply.code(400).send({ error: 'faltan desde/hasta (YYYY-MM-DD)' });
    const rows = listFacturas(r.desdeMs, r.hastaMs);
    return { facturas: rows, kpis: kpis(rows) };
  });

  app.get('/admin/conta/resumen', async (req, reply) => {
    if (!requireConta(req, reply)) return;
    const year = Number(req.query?.year) || bogota(Date.now()).y;
    return resumenYear(year);
  });

  // Descargas: Bearer del panel O token firmado (?t=) de los links del correo.
  app.get('/admin/conta/export', async (req, reply) => {
    const { kind, desde, hasta, t } = req.query || {};
    const tokenOk = t && verifyDownload(kind, desde, hasta, t);
    if (!tokenOk && !requireConta(req, reply)) return;
    const r = parseRange({ desde, hasta });
    if (!r || !['xlsx', 'csv', 'zip'].includes(kind)) {
      return reply.code(400).send({ error: 'kind (xlsx|csv|zip) + desde/hasta (YYYY-MM-DD)' });
    }
    const rows = listFacturas(r.desdeMs, r.hastaMs);
    const name = `sono-contable-${desde}_${hasta}`;
    if (kind === 'csv') {
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${name}.csv"`)
        .send(libroCsv(rows));
    }
    if (kind === 'xlsx') {
      const buf = await libroXlsx(rows, r.desdeMs, r.hastaMs);
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${name}.xlsx"`)
        .send(buf);
    }
    const buf = await paqueteZip(rows);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${name}.zip"`)
      .send(buf);
  });
}
