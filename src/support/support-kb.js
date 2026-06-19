// Base de conocimiento del bot de soporte de Sonó (APROBADA por el dueño, jun-2026).
//
// Esta es la ÚNICA fuente de verdad del bot. Gemini SOLO puede responder con esto.
// Si la pregunta no se puede contestar con esta info → el bot NO inventa: escala al
// humano (escalate=true). Ver gemini.js para el guardarraíl.
//
// Reglas de contenido (decisiones del usuario):
//  - Precios: mensual dispositivo $89.000 + servicio $25.000/mes (1er mes gratis);
//    anual $199.000 todo incluido.
//  - Conexión con el banco: decir SOLO "Sonó se conecta con tu banco para detectar
//    los pagos". NO explicar correo/OAuth/IMAP/redirección ni ningún detalle técnico.
//  - Tono: TÚ neutro colombiano (no voseo), directo, honesto, sin humo.
//  - WhatsApp: aún NO operativo. Único canal humano hoy: este chat / hola@sono.lat.
//  - Bancos: solo Bancolombia y Nequi hoy. No prometer fechas de otros.

export const SUPPORT_KB = `
# QUÉ ES SONÓ
Sonó es un altavoz que anuncia en voz alta cada pago QR que recibe tu negocio.
Cuando un cliente te paga con su QR, Sonó lo dice en voz alta al instante:
"Recibiste cinco mil pesos". Lema: "Cada pago se escucha".
Vendes tranquilo sin revisar el celular, y tu equipo escucha cada venta aunque no
tenga acceso a tu cuenta. Un pantallazo se edita; un sonido, no: Sonó solo suena
cuando la plata ya entró de verdad a tu cuenta.

# DINERO Y COMISIONES
- Sonó NO cobra ninguna comisión por venta. 0% siempre.
- Tu plata llega directa a tu banco, completa, como siempre. Nadie se mete en el medio.
- Sonó solo escucha el pago llegar; no toca el dinero.

# CÓMO FUNCIONA (para el comerciante)
1. El cliente paga con tu QR, con el banco que quiera, como siempre. No cambia nada para él.
2. Sonó se conecta con tu banco y detecta el pago en menos de 2 segundos.
3. El altavoz lo anuncia en voz alta. Tú y tu personal escuchan el monto al instante.
No necesitas abrir ninguna app para que funcione.

# BANCOS Y BILLETERAS
- Hoy Sonó anuncia los pagos que te llegan a Bancolombia y Nequi (lo más usado en Colombia).
- Tu cliente puede pagarte desde CUALQUIER banco o billetera; tu QR no cambia ni tiene
  restricciones para quien te paga.
- Próximamente se integran más bancos y billeteras, sin que tengas que cambiar nada en tu Sonó.

# PLANES Y PRECIOS (lanzamiento)
Plan Mensual:
  - Pagas el dispositivo una sola vez: $89.000 (precio normal $100.000).
  - Servicio: $25.000 al mes. El primer mes de servicio es GRATIS.
  - Sin permanencia: cancelas cuando quieras y el dispositivo sigue siendo tuyo.
Plan Anual:
  - Un solo pago de $199.000 al año (precio normal $400.000), con el dispositivo incluido.
  - No se renueva automáticamente: cuando se cumpla el año, renuevas solo si quieres seguir.
Ambos planes incluyen: el dispositivo Sonó WiFi, el envío a todo Colombia, La Libreta
(panel web donde tus ventas se apuntan solas) y un sticker QR personalizado con tu negocio.
Nunca hay comisión por venta en ningún plan.

# REQUISITOS PARA QUE FUNCIONE
- WiFi de 2.4 GHz en el local (por ahora Sonó se conecta por WiFi).
- Recibir tus pagos en Bancolombia o Nequi.
- La versión 4G (para locales sin internet propio) está en camino, muy pronto.

# ENVÍO
- Llega entre 24 y 48 horas hábiles dentro de Colombia.
- Llega ya configurado y con tu QR impreso: solo lo enchufas y lo conectas al WiFi.
- El envío está incluido en ambos planes.

# LA LIBRETA (incluida)
- Es un panel web donde tus ventas quedan apuntadas solas, en vivo.
- La abres desde cualquier celular o computador, sin instalar ninguna app.
- Ves cuánto llevas hoy, cuánto hiciste ayer y tus mejores horas.
- Si tu Sonó se queda sin internet, te avisa antes de que pierdas un anuncio.

# ¿NECESITO UNA APP?
No. Sonó funciona solo: lo dejas configurado una vez y anuncia cada venta sin que toques
nada. Para ver tus ventas usas La Libreta desde el navegador, sin instalar nada.

# PERMANENCIA
No hay cláusula de permanencia en ningún plan. Mensual: cancelas cuando quieras y el
dispositivo es tuyo. Anual: pagas el año por adelantado y renuevas solo si quieres. Sin
multas ni ataduras.

# PRIVACIDAD Y SEGURIDAD
- Sonó se conecta con tu banco únicamente para detectar tus avisos de pago y anunciarlos.
- Solo lee los avisos de pago; nunca envía, modifica ni borra nada, y no accede a otra
  información. Puedes desconectarlo cuando quieras.
- No vendemos ni compartimos tus datos con terceros para marketing.
- Más detalle en la Política de privacidad de sono.lat.

# DISPONIBILIDAD Y "¿ES 100% GARANTIZADO?" (honestidad)
La mayoría de las veces el aviso suena en segundos. Pero seamos claros: Sonó se conecta
con tu banco para detectar cada pago, así que depende del propio banco. Si el sistema del
banco se satura o se cae, un aviso puede demorarse o, de vez en cuando, no llegar. Eso no
depende de nosotros, así que NO podemos garantizar que cada anuncio suene al 100%.
También influye que tu internet esté disponible (cortes de luz o de WiFi). Hacemos el mejor
esfuerzo para que funcione siempre, y por eso La Libreta te avisa si tu Sonó se queda sin
conexión. Lo que SÍ es seguro: Sonó solo suena cuando la plata ya entró de verdad a tu
cuenta. Si el cliente pregunta por una garantía de devolución o cambio del aparato, no
tenemos esa información acá: escala a una persona del equipo.

# CONTACTO Y SOPORTE
- Escribiéndonos por este chat un humano del equipo puede ayudarte.
- Correo: hola@sono.lat
- Ubicación: Medellín, Colombia.
- (La atención por WhatsApp llegará próximamente.)

# CÓMO COMPRAR
Eliges tu plan (mensual o anual) en sono.lat y completas la compra. Después recibes los
pasos para dejar tu Sonó listo y te llega a casa configurado en 24-48 horas.
`.trim();

// Temas que el bot NUNCA debe inventar ni detallar (si preguntan, escala u ofrece el dato
// genérico permitido). Sirve como recordatorio en el system prompt.
export const FORBIDDEN_TOPICS = [
  'detalles técnicos de cómo se conecta al banco (correo, OAuth, IMAP, reenvío)',
  'datos internos del hardware, firmware, MQTT, IPs, marcas de chips o módems',
  'precios distintos a los de esta base de conocimiento',
  'fechas concretas de lanzamiento de funciones futuras (4G, otros bancos)',
  'promesas de garantía, reembolsos o plazos que no estén escritos aquí',
  'datos personales del dueño, credenciales o información de otros clientes',
];
