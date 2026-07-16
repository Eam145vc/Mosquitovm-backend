// Definiciones de las plantillas de WhatsApp Cloud API (categoría UTILITY, 'es').
// Módulo SIN dependencias del resto del backend: lo importa wa-cloud.js (runtime)
// y scripts/create-wa-templates.js (que debe poder correr suelto, sin el Zod de
// config.js exigiendo MQTT_URL y compañía).
//
// Reglas duras de Meta que estas definiciones respetan (no romper al editar):
// - El body NO puede EMPEZAR ni TERMINAR con una variable {{n}} (INVALID_FORMAT).
// - Las variables no admiten saltos de línea ni 4+ espacios seguidos.
// - El botón URL admite UNA sola variable y va al FINAL de la URL (por eso
//   ?correo=1 va ANTES de order=).
// ⚠️ Estos textos son la fuente de verdad de lo que el CLIENTE recibe por la
// Cloud API (buildWaBody de wa-enqueue.js solo aplica al agente PC/Evolution).
// Cambiar un body acá NO cambia nada en Meta: hay que re-crear la plantilla
// (versionar el nombre) y esperar aprobación. El script de creación avisa si
// detecta drift entre este archivo y lo que Meta tiene registrado.

// La base queda CONGELADA en Meta al crear la plantilla; se toma del entorno solo
// para la creación (default = dominio de producción).
const BASE = (process.env.FRONTEND_BASE_URL || 'https://sono.lat').replace(/\/$/, '');
const ACTIVAR = `${BASE}/activar-pro?order=`;
const ACTIVAR_CORREO = `${BASE}/activar-pro?correo=1&order=`;
const LIBRETA = `${BASE}/libreta/?order=`;

const RASTREO_EJ = 'https://coordinadora.com/rastreo/240001234567';

export const WA_TEMPLATES = {
  sono_activacion: {
    body: 'Hola {{1}} 👋 ¡Gracias por tu compra en Sonó! Para enviarte tu equipo solo falta que subas tu QR de Bre-B. Toma 2 minutos desde el celular.',
    bodyExample: ['Carlos'],
    button: { text: 'Subir mi QR', urlBase: ACTIVAR },
  },
  sono_recordatorio_qr: {
    body: 'Hola {{1}}, tu Sonó sigue esperando tu QR de Bre-B para poder despacharse. Es un paso de 2 minutos y con eso lo enviamos. Si necesitas ayuda, escríbenos por aquí.',
    bodyExample: ['Carlos'],
    button: { text: 'Subir mi QR', urlBase: ACTIVAR },
  },
  sono_guia_creada: {
    body: 'Hola {{1}} 📦 ¡Tu Sonó ya tiene guía de envío! Guía {{2}} por {{3}}. Revisa que tus datos de entrega estén correctos: {{4}} — {{5}}. Si algo está mal, escríbenos por aquí YA para corregirlo antes del despacho. Sigue tu paquete en {{6}} cuando quieras.',
    bodyExample: ['Carlos', '240001234567', 'Coordinadora', 'Tienda Don Carlos', 'Cra 10 # 20-30, Bogotá', RASTREO_EJ],
  },
  sono_guia_creada_cod: {
    body: 'Hola {{1}} 📦 ¡Tu Sonó ya tiene guía de envío! Guía {{2}} por {{3}}. Revisa que tus datos de entrega estén correctos: {{4}} — {{5}}. Si algo está mal, escríbenos por aquí YA para corregirlo antes del despacho. 💵 Al recibir pagas {{6}} en efectivo al mensajero. Sigue tu paquete en {{7}} cuando quieras.',
    bodyExample: ['Carlos', '240001234567', 'Coordinadora', 'Tienda Don Carlos', 'Cra 10 # 20-30, Bogotá', '$189.000', RASTREO_EJ],
  },
  sono_en_camino: {
    body: 'Hola {{1}} 🚚 ¡Tu Sonó ya va en camino! La transportadora recogió el paquete. Te avisamos cuando salga a entrega.',
    bodyExample: ['Carlos'],
  },
  sono_reparto: {
    body: 'Hola {{1}} 📦 ¡Tu Sonó está en reparto y te llega HOY! Mantente atento al mensajero. Sigue tu paquete en {{2}} si quieres verlo en vivo.',
    bodyExample: ['Carlos', RASTREO_EJ],
  },
  sono_reparto_cod: {
    body: 'Hola {{1}} 📦 ¡Tu Sonó está en reparto y te llega HOY! Mantente atento al mensajero. 💵 Recuerda tener {{2}} en efectivo para el mensajero. Sigue tu paquete en {{3}} si quieres verlo en vivo.',
    bodyExample: ['Carlos', '$189.000', RASTREO_EJ],
  },
  sono_intento_entrega: {
    body: 'Hola {{1}}, la transportadora intentó entregar tu Sonó y no fue posible 😕 Suelen reintentar el próximo día hábil, mantente atento al mensajero. ¿Algún problema con la dirección? Escríbenos por aquí para que el paquete no se devuelva. Sigue tu paquete en {{2}} para más detalle.',
    bodyExample: ['Carlos', RASTREO_EJ],
  },
  sono_entregado: {
    body: 'Hola {{1}} 🎉 ¡Tu Sonó fue entregado! Último paso para que anuncie tus ventas: conecta el correo donde te avisan los pagos. Toma 2 minutos y quedas al aire.',
    bodyExample: ['Carlos'],
    button: { text: 'Conectar mi correo', urlBase: ACTIVAR_CORREO },
  },
  sono_correo: {
    body: 'Hola {{1}} 👋 ¿Ya tienes tu Sonó contigo? Falta un solo paso para que anuncie tus ventas: conecta el correo donde te avisan los pagos. Si te trabas, escríbenos por aquí.',
    bodyExample: ['Carlos'],
    button: { text: 'Conectar mi correo', urlBase: ACTIVAR_CORREO },
  },
  sono_libreta: {
    body: 'Hola {{1}} 📒 Esta es tu Libreta: ahí ves cada venta entrar en vivo, cuánto llevas hoy y tus mejores horas. Es tu enlace personal, guárdalo.',
    bodyExample: ['Carlos'],
    button: { text: 'Abrir mi Libreta', urlBase: LIBRETA },
  },
};
