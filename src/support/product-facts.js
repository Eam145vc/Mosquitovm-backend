// HECHOS DE PRECIOS compartidos por los DOS cerebros de soporte: la KB de Valeria
// (support-kb.js, bot de la web) y el playbook del rayito (agent-suggest.js, borradores
// de WhatsApp). Nació el 5-ago-2026 después de que la migración de precios v2 se aplicó
// en un prompt y no en el otro (el rayito siguió citando $17.000/mes a un prospecto).
//
// Los NÚMEROS vienen de pricing.js — la misma fuente que cobra las cuotas reales.
// Un precio nuevo se cambia allá UNA vez y llega solo a ambos prompts. Este archivo
// solo REDACTA; jamás define un valor propio.
//
// Lo que cada prompt conserva aparte es su personalidad (Valeria escala a humano y
// vende en la web; el rayito escribe en la voz del dueño): acá va solo lo que debe
// ser idéntico en ambos.
import {
  CUOTA_V1_CENTS, CUOTA_V2_CENTS,
  PRECIO_LANZAMIENTO_CENTS, PRECIO_NORMAL_CENTS, RECARGO_CONTRAENTREGA_CENTS,
  CONTINUIDAD_MES_V2_CENTS, CONTINUIDAD_MES_V1_CENTS, CONTINUIDAD_ANUAL_CENTS,
} from '../pricing.js';

const $ = (cents) => '$' + Math.round(cents / 100).toLocaleString('es-CO');

const CUOTA = $(CUOTA_V2_CENTS);
const CUOTA_VIEJA = $(CUOTA_V1_CENTS);
const PRECIO = $(PRECIO_LANZAMIENTO_CENTS);
const NORMAL = $(PRECIO_NORMAL_CENTS);
const COD_TOTAL = $(PRECIO_LANZAMIENTO_CENTS + RECARGO_CONTRAENTREGA_CENTS);
const RECARGO = $(RECARGO_CONTRAENTREGA_CENTS);
const CONT_MES = $(CONTINUIDAD_MES_V2_CENTS);
const CONT_MES_VIEJA = $(CONTINUIDAD_MES_V1_CENTS);
const CONT_ANO = $(CONTINUIDAD_ANUAL_CENTS);

export const PRECIOS_FACTS = `
═══ PRECIOS Y PLANES (fuente única — JAMÁS inventar otros números) ═══
El precio de lanzamiento es ${PRECIO} (precio normal ${NORMAL}), pagable de dos formas:
- De una: ${PRECIO} con el envío incluido. Contraentrega: ${COD_TOTAL} al recibir
  (${PRECIO} + ${RECARGO} de recaudo).
- En cuotas: 3 cuotas de ${CUOTA} más el envío según la ciudad. Decirlo SIMPLE: "hoy
  pagas la 1ª cuota + el envío de tu ciudad (el checkout te muestra el valor exacto al
  poner la ciudad)" y luego 2 cuotas de ${CUOTA} cada 30 días (si pagó con tarjeta se
  cobran solas; con otro medio le llega un enlace de pago; si no paga una cuota el
  servicio se suspende hasta ponerse al día). Contraentrega en cuotas: al recibir paga
  la 1ª cuota + el envío + ${RECARGO} de recargo, y luego las otras 2 cuotas.
  ⚠️ NO dar rangos de plata ("entre $86.000 y $100.000") ni la tabla completa de envíos:
  confunden. El envío de UNA ciudad solo si lo preguntan directo: $11.000 Medellín y
  área metro, $15.000 principales, $20.000 intermedias, $25.000 alejadas.
  ⚠️ COHORTE CUOTAS: quien compró ANTES del 6-ago-2026 conserva sus cuotas de ${CUOTA_VIEJA}.
- Ambos planes incluyen: el dispositivo (queda DEL CLIENTE para siempre), todo el
  PRIMER AÑO de servicio incluido (NO decir "gratis": el servicio se factura, va
  incluido en el precio), el sticker QR personalizado y "La Libreta". Envío en 24-48h
  hábiles a toda Colombia.
- CERO comisiones por venta, siempre. Sin mensualidades el primer año. NO existe plan
  mensual de compra, ni "dispositivo gratis", ni "$29.900/mes".
- CONTINUIDAD desde el 2º año (decirla SOLO si preguntan por costos futuros): el
  servicio SIGUE (di "tu servicio sigue", no "renovación") por ${CONT_MES}/mes o
  ${CONT_ANO}/año por equipo, a elección, y solo se cobra si decide seguir. Sin
  permanencia ni multas; si no continúa, el equipo sigue siendo suyo.
  ⚠️ COHORTE CONTINUIDAD: quien compró ANTES del 6-ago-2026 conserva ${CONT_MES_VIEJA}/mes
  o ${CONT_ANO}/año. Si el contexto trae "CONDICIONES DE SU COMPRA", usa ESOS números;
  si NO hay orden vinculada (prospecto nuevo), usa SIEMPRE los vigentes (${CONT_MES}/mes).
- El año incluido es UNO (el primero). "A partir del 2º año" = cuándo empieza el cobro
  si el servicio sigue.
- Links de compra: https://sono.lat/checkout?plan=contado y https://sono.lat/checkout?plan=cuotas
`.trim();
