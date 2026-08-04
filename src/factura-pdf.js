// Representación gráfica de la factura electrónica (PDF con QR y CUFE).
// Se genera al vuelo desde los metadatos que facturacion.js dejó en facturas/<id>.json.
// El QR apunta al validador público de la DIAN (catalogo-vpfe .../searchqr?documentkey=CUFE),
// que es lo que exige el anexo técnico para la representación gráfica.

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { FACTURAS_DIR } from './facturacion.js';

const cop = (n) => `$${Number(n).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Genera el PDF de la factura `invoiceNumber` (ej "SONO12"). Devuelve un Buffer o null. */
export async function facturaPdf(invoiceNumber) {
  const metaPath = path.join(FACTURAS_DIR, `${invoiceNumber}.json`);
  if (!fs.existsSync(metaPath)) return null;
  const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

  const qrUrl = `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${m.cufe}`;
  const qrPng = await QRCode.toBuffer(qrUrl, { width: 220, margin: 1 });

  const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => doc.on('end', () => res(Buffer.concat(chunks))));

  const verde = '#18a848';
  const gris = '#4a5168';
  const negro = '#0a0f1f';

  // Encabezado
  doc.fillColor(verde).fontSize(24).font('Helvetica-Bold').text('Sonó', 48, 48);
  doc.fillColor(gris).fontSize(9).font('Helvetica')
    .text('Sono Tech S.A.S — NIT 902078586-1', 48, 78)
    .text('Calle 42 # 80A-39, Medellín, Antioquia', 48, 90)
    .text('facturas@sono.lat — sono.lat', 48, 102);

  doc.fillColor(negro).fontSize(13).font('Helvetica-Bold')
    .text('FACTURA ELECTRÓNICA DE VENTA', 300, 52, { width: 264, align: 'right' });
  doc.fillColor(verde).fontSize(16).text(m.id, 300, 70, { width: 264, align: 'right' });
  doc.fillColor(gris).fontSize(9).font('Helvetica')
    .text(`Fecha: ${new Date(m.at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`, 300, 92, { width: 264, align: 'right' });

  doc.moveTo(48, 122).lineTo(564, 122).strokeColor('#e4e4de').stroke();

  // Cliente
  doc.fillColor(gris).fontSize(8).font('Helvetica-Bold').text('FACTURADA A', 48, 134);
  doc.fillColor(negro).fontSize(11).font('Helvetica-Bold').text(m.customer.name, 48, 146);
  doc.fillColor(gris).fontSize(9).font('Helvetica')
    .text(`${m.customer.type === '31' ? 'NIT' : 'CC'} ${m.customer.doc}`, 48, 161);

  // Detalle
  const y0 = 195;
  doc.rect(48, y0, 516, 22).fill('#f4f4ef');
  doc.fillColor(gris).fontSize(8).font('Helvetica-Bold')
    .text('DESCRIPCIÓN', 56, y0 + 7)
    .text('CANT.', 380, y0 + 7)
    .text('VALOR', 470, y0 + 7, { width: 86, align: 'right' });
  doc.fillColor(negro).fontSize(10).font('Helvetica')
    .text(m.descripcion, 56, y0 + 30, { width: 310 })
    .text('1', 380, y0 + 30)
    .text(cop(m.base), 470, y0 + 30, { width: 86, align: 'right' });

  // Totales
  const yT = y0 + 78;
  doc.moveTo(340, yT).lineTo(564, yT).strokeColor('#e4e4de').stroke();
  doc.fillColor(gris).fontSize(10).font('Helvetica')
    .text('Subtotal (base)', 340, yT + 10).text(cop(m.base), 470, yT + 10, { width: 86, align: 'right' })
    .text('IVA 19%', 340, yT + 26).text(cop(m.iva), 470, yT + 26, { width: 86, align: 'right' });
  doc.fillColor(negro).fontSize(12).font('Helvetica-Bold')
    .text('TOTAL', 340, yT + 46).text(cop(m.total), 450, yT + 46, { width: 106, align: 'right' });
  doc.fillColor(gris).fontSize(9).font('Helvetica')
    .text(`Forma de pago: ${m.plan === 'cuotas' ? 'Crédito (cuotas)' : 'Contado'}`, 340, yT + 68);

  // QR + CUFE
  const yQ = yT + 100;
  doc.image(qrPng, 48, yQ, { width: 110 });
  doc.fillColor(gris).fontSize(8).font('Helvetica-Bold').text('CUFE', 170, yQ + 4);
  doc.fillColor(negro).fontSize(7).font('Helvetica').text(m.cufe, 170, yQ + 15, { width: 390 });
  doc.fillColor(gris).fontSize(8)
    .text('Verifica esta factura escaneando el QR o en catalogo-vpfe.dian.gov.co', 170, yQ + 44, { width: 390 })
    .text('Autorización de numeración DIAN 18764113503344 del 2026-08-03,', 170, yQ + 62, { width: 390 })
    .text('prefijo SONO del 1 al 500.000, vigencia hasta 2028-08-03.', 170, yQ + 74, { width: 390 });

  doc.fillColor('#9aa0ae').fontSize(8)
    .text('Factura electrónica de venta generada y firmada por Sono Tech S.A.S — validación previa DIAN.', 48, 700, { width: 516, align: 'center' });

  doc.end();
  return done;
}
