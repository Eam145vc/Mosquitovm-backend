// Precios que dependen de la FECHA de la orden. Sin imports: lo consumen
// http-server, installments-scheduler y los wa-* sin riesgo de ciclos.
//
// El 6-ago-2026 entraron los términos v2 (modelo SaaS excluido de IVA) y la cuota
// subió de $69.000 a $75.000. Cada cliente paga LA CUOTA DEL PRECIO AL QUE COMPRÓ:
// las órdenes anteriores al corte conservan sus $69.000 (su contrato), las nuevas
// van a $75.000. El corte es por created_at de la orden — nunca por fecha del cobro.

/** 6-ago-2026 00:00 Bogotá (UTC-5): entrada en vigencia de términos y precios v2. */
export const V2_DESDE = Date.UTC(2026, 7, 6, 5);

export const CUOTA_V1_CENTS = 6_900_000;   // órdenes hasta el 5-ago-2026
export const CUOTA_V2_CENTS = 7_500_000;   // órdenes desde el 6-ago-2026

/** ¿La orden se rige por los términos/modelo v2? La vara PRINCIPAL es la versión de
 *  términos que el cliente aceptó en el checkout (terms_version, exacta aunque la
 *  compra caiga en la ventana entre el deploy y la medianoche del corte); la fecha
 *  es el respaldo para órdenes sin evidencia (ej. creadas por el admin). */
export function esOrdenV2(order) {
  if (!order) return false;
  if (order.terms_version) return String(order.terms_version).startsWith('v2');
  return Boolean(order.created_at && order.created_at >= V2_DESDE);
}

/** Cuota 2/3 de UNA orden concreta: la del precio al que compró. */
export function cuotaCentsFor(order) {
  return esOrdenV2(order) ? CUOTA_V2_CENTS : CUOTA_V1_CENTS;
}

// ── Registro canónico del resto de precios (v2, 6-ago-2026) ──
// Los leen product-facts.js (prompts de Valeria y el rayito) y quien los necesite.
// El backend aún NO cobra la continuidad; cuando se cobre, se cobra de AQUÍ.
export const PRECIO_LANZAMIENTO_CENTS = 19_900_000;   // $199.000 (equipo + 1er año)
export const PRECIO_NORMAL_CENTS = 40_000_000;        // $400.000 (ancla tachada)
export const RECARGO_CONTRAENTREGA_CENTS = 500_000;   // $5.000 al recibir
export const CONTINUIDAD_MES_V2_CENTS = 2_500_000;    // $25.000/mes desde 6-ago-2026
export const CONTINUIDAD_MES_V1_CENTS = 1_700_000;    // $17.000/mes pre-6-ago (se honra)
export const CONTINUIDAD_ANUAL_CENTS = 19_900_000;    // $199.000/año (ambas cohortes)
