// Tarifas de envío por zona (jul-2026, decisión del dueño): tarifa PLANA según la
// ciudad de destino, sin cotizar Skydropx en vivo. Máximo $25.000 — ningún destino
// requiere confirmación previa. El envío se cobra SOLO en el plan cuotas (la 1ª
// cuota); el plan de una ($199.000) sigue con envío incluido.
//
// La zona sale del código DANE (DIVIPOLA, 5 dígitos: los 2 primeros = departamento)
// que el checkout ya captura con el autocomplete de co-dane.js:
//   - metro       $11.000 → Medellín + Valle de Aburrá (bodega en Medellín)
//   - principales $15.000 → capitales grandes y sus municipios metropolitanos
//   - lejanas     $25.000 → departamentos de difícil acceso (por prefijo)
//   - intermedias $20.000 → todo lo demás (también el fallback sin DANE)

export const ENVIO_METRO = 11_000;
export const ENVIO_PRINCIPALES = 15_000;
export const ENVIO_INTERMEDIAS = 20_000;
export const ENVIO_LEJANAS = 25_000;

// Valle de Aburrá completo (10 municipios).
const DANE_METRO = new Set([
  '05001', // Medellín
  '05088', // Bello
  '05360', // Itagüí
  '05266', // Envigado
  '05631', // Sabaneta
  '05380', // La Estrella
  '05129', // Caldas
  '05212', // Copacabana
  '05308', // Girardota
  '05079', // Barbosa
]);

// Capitales principales + municipios metropolitanos donde las transportadoras
// cobran tarifa de ciudad.
const DANE_PRINCIPALES = new Set([
  '11001', // Bogotá
  '25754', // Soacha
  '25175', // Chía
  '76001', // Cali
  '76892', // Yumbo
  '76364', // Jamundí
  '76520', // Palmira
  '08001', // Barranquilla
  '08758', // Soledad
  '08433', // Malambo
  '13001', // Cartagena
  '68001', // Bucaramanga
  '68276', // Floridablanca
  '68307', // Girón
  '68547', // Piedecuesta
  '54001', // Cúcuta
  '54405', // Los Patios
  '54874', // Villa del Rosario
  '66001', // Pereira
  '66170', // Dosquebradas
  '17001', // Manizales
  '17873', // Villamaría
  '63001', // Armenia
  '73001', // Ibagué
  '47001', // Santa Marta
  '50001', // Villavicencio
  '23001', // Montería
  '41001', // Neiva
  '52001', // Pasto
  '15001', // Tunja
  '19001', // Popayán
  '20001', // Valledupar
  '70001', // Sincelejo
  '44001', // Riohacha
]);

// Departamentos de difícil acceso: TODO el departamento va a $25.000 (incluidas
// capitales — allá las transportadoras recargan trayecto especial).
const DEPTOS_LEJANOS = new Set([
  '91', // Amazonas
  '27', // Chocó
  '94', // Guainía
  '95', // Guaviare
  '86', // Putumayo
  '97', // Vaupés
  '99', // Vichada
  '88', // San Andrés y Providencia
  '81', // Arauca
]);

/**
 * Tarifa de envío en PESOS para un código DANE. Sin DANE (texto libre de una
 * página vieja cacheada) cae a intermedias: es el valor más común y no castiga
 * a nadie con el tope.
 */
export function envioPorDane(dane) {
  const d = String(dane || '').trim();
  if (!/^\d{5}$/.test(d)) return ENVIO_INTERMEDIAS;
  if (DANE_METRO.has(d)) return ENVIO_METRO;
  if (DANE_PRINCIPALES.has(d)) return ENVIO_PRINCIPALES;
  if (DEPTOS_LEJANOS.has(d.slice(0, 2))) return ENVIO_LEJANAS;
  return ENVIO_INTERMEDIAS;
}
