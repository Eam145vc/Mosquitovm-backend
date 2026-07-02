// Base de conocimiento del bot de soporte de Sonó (APROBADA por el dueño, jun-2026).
//
// Esta es la ÚNICA fuente de verdad del bot. Gemini SOLO puede responder con esto.
// Si la pregunta no se puede contestar con esta info → el bot NO inventa: escala al
// humano (escalate=true). Ver gemini.js para el guardarraíl.
//
// Reglas de contenido (decisiones del usuario):
//  - Precios (jun-2026, alineados con sono-web/lib/plans.ts, fuente única):
//    Precio $199.000 (normal $400.000), pagable de DOS formas: de una ($199.000) o
//    en 3 cuotas de $69.000 + $12.000 de envío (hoy paga $81.000; total $219.000).
//    El de UNA incluye envío; el de CUOTAS NO (suma $12.000 de envío en la 1ª cuota).
//    Incluye el dispositivo Sonó + el PRIMER AÑO de servicio GRATIS. El cliente se LLEVA
//    el aparato (es suyo). NO decir "pago único" (ya hay cuotas).
//    PAGO CONTRAENTREGA: SOLO pagando de una ($199.000), +$5.000 que paga AL RECIBIR. Se
//    confirma por WhatsApp antes de despachar. El plan en CUOTAS NO tiene contraentrega
//    (se paga en línea). Online: tarjeta, PSE, Bre-B o efectivo.
//      - La renovación del servicio: $17.000 mensuales O $199.000 al año (dos opciones reales),
//        NO mencionar la renovación de forma proactiva. SOLO darla si el cliente
//        PREGUNTA DIRECTO "¿cuánto pago el año que viene / la renovación?".
//    NO existe plan mensual, ni "dispositivo gratis", ni "$29.900/mes", ni "1er mes
//    gratis", ni "$89.000": todo eso quedó DEPRECADO. No lo menciones nunca.
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

# CÓMO SE VINCULA AL BANCO (si preguntan de qué manera se conecta)
Sonó se vincula extrayendo los pagos directamente del sistema de pagos y notificaciones
de Bancolombia o Nequi. Es una conexión segura que dejas lista UNA sola vez cuando recibes
tu equipo, con una guía paso a paso. Sonó no toca tu dinero ni puede moverlo: solo detecta
cada pago que entra para anunciarlo en voz alta.
[INTERNO — SOLO si el cliente insiste con más detalle ("¿pero cómo exactamente?"): puedes
decirle que se conecta directamente el correo donde le llegan las notificaciones del banco.
NO des más detalle que ese (nada de Gmail, OAuth, IMAP, reenvío ni términos técnicos).]

# BANCOS Y BILLETERAS
- Hoy Sonó anuncia los pagos que te llegan a Bancolombia (App Bancolombia PERSONAS) y a Nequi.
- ⚠️ IMPORTANTE: NO funciona con Bancolombia NEGOCIOS. Solo con cuentas de PERSONAS
  (App Bancolombia Personas: cuenta de ahorros o corriente normal) y con Nequi. Si el
  cliente dice que recibe los pagos en Bancolombia Negocios, avísale con amabilidad que
  por ahora el equipo NO le sirve para esa cuenta, y pregúntale si de casualidad también
  recibe pagos en una cuenta de Personas (ahorros/corriente normal) o en Nequi, para ver
  si le sirve. NO le vendas si solo tiene Bancolombia Negocios.
- Tu cliente (quien te paga) puede pagarte desde CUALQUIER banco o billetera; tu QR no
  cambia ni tiene restricciones para quien te paga. La limitación es solo sobre la cuenta
  TUYA donde RECIBES (debe ser Bancolombia Personas o Nequi).
- Próximamente se integran más bancos y billeteras, sin que tengas que cambiar nada en tu Sonó.

# PLANES Y PRECIOS (lanzamiento)
El precio de lanzamiento es $199.000 (precio normal $400.000), y lo puedes pagar de dos formas:
  - De una: $199.000, con el envío incluido.
  - En cuotas: 3 cuotas de $69.000 más $12.000 de envío. Hoy pagas $81.000 (la 1ª cuota + el envío) y luego 2 cuotas de $69.000. En total son $219.000.
Con cualquiera de las dos te llevas:
  - El dispositivo Sonó WiFi (es tuyo, te queda).
  - El primer año de servicio GRATIS.
  - La Libreta (panel web donde tus ventas se apuntan solas).
  - Un sticker QR personalizado con tu negocio.
El envío va incluido en el pago de una; en cuotas son $12.000 aparte.
No hay mensualidades. Nunca hay comisión por venta, 0% siempre.

# FORMAS DE PAGO Y CONTRAENTREGA
Puedes pagar en línea (tarjeta de crédito o débito, PSE, Bre-B o efectivo por corresponsal).
El pago contraentrega está disponible SOLO pagando de una ($199.000): pagas al recibir tu
Sonó, con un recargo de $5.000 por el recaudo, y te confirmamos el pedido por WhatsApp antes
de despacharlo; en ese caso no se cobra nada por adelantado. El plan en cuotas se paga en
línea (la 1ª cuota + envío al comprar), NO tiene contraentrega.
[INTERNO — sobre las cuotas, si preguntan cómo se pagan: la 1ª cuota se paga al comprar;
las otras 2 se cobran en los meses siguientes. Si pagó con tarjeta se cobran solas; con
otro medio (PSE, etc.) le llega un enlace de pago. Si no paga una cuota, el servicio se
suspende hasta ponerse al día.]
[INTERNO — usar SOLO si el cliente pregunta DIRECTO por la renovación o "¿cuánto pago
el próximo año?": el primer año va incluido; a partir del segundo año la renovación del
servicio puedes pagarla $17.000 mensuales o $199.000 al año (lo que prefieras), y solo
renuevas si quieres seguir. NO ofrecer este dato
si no lo piden.]

# REQUISITOS PARA QUE FUNCIONE
- WiFi de 2.4 GHz en el local (por ahora Sonó se conecta por WiFi).
- Recibir tus pagos en Bancolombia o Nequi.
- La versión 4G (para locales sin internet propio) está en camino, muy pronto.

# PROCESO DESPUÉS DE COMPRAR (importante, decirlo bien)
El orden real es: 1) haces tu compra en sono.lat; 2) completas un paso corto de
activación donde SOLO nos compartes tu código QR de pagos (una foto del QR con el que
te pagan tus clientes); 3) SOLO DESPUÉS de eso despachamos tu Sonó, que sale ya
configurado y con TU QR impreso; 4) te llega, lo enchufas, lo conectas al WiFi y
terminas la conexión con tu banco ahí mismo, con una guía paso a paso.
NO digas que en la activación se conecta el correo del banco: eso ya NO es parte del
paso inicial (la conexión con el banco se completa cuando recibes el equipo).
IMPORTANTE: el dispositivo NO se envía antes de que completes ese proceso y nos mandes tu
QR (lo necesitamos para dejarlo configurado y para imprimir tu sticker). Así que NO digas
que "llega y ya" sin más: primero va el proceso de activación + tu QR, y luego el envío.

# ENVÍO
- Una vez completas el proceso y nos das tu QR, llega entre 24 y 48 horas hábiles dentro de Colombia.
- Sale ya configurado y con tu QR impreso: solo lo enchufas y lo conectas al WiFi.
- El envío va incluido en el pago de una; en el plan en cuotas son $12.000 aparte.

# LA LIBRETA (incluida)
- Es un panel web donde tus ventas quedan apuntadas solas, en vivo.
- La abres desde cualquier celular o computador, sin instalar ninguna app.
- Ves cuánto llevas hoy, cuánto hiciste ayer y tus mejores horas.
- Si tu Sonó se queda sin internet, te avisa antes de que pierdas un anuncio.

# ¿NECESITO UNA APP?
No. Sonó funciona solo: lo dejas configurado una vez y anuncia cada venta sin que toques
nada. Para ver tus ventas usas La Libreta desde el navegador, sin instalar nada.

# PERMANENCIA
No hay cláusula de permanencia. El dispositivo queda siendo tuyo y
no quedas atado a nada: al cumplirse el año renuevas el servicio solo si quieres seguir.
Sin multas ni ataduras.

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

# QUIERO VENDER / TRABAJAR CON SONÓ (distribuidores, aliados, empleo)
Si alguien dice que quiere vender Sonó, trabajar con nosotros, ser distribuidor o aliado,
o propone un negocio: NO escales ni digas que confirmas con el equipo. Respóndele con
calidez que ese tipo de solicitudes las atiende el equipo directamente por el correo
hola@sono.lat: que escriba allí contando quién es, su ciudad y su WhatsApp, y el equipo
toma la solicitud y le responde personalmente. Agradécele el interés. NO prometas plazos
de respuesta ni condiciones comerciales (comisiones, precios de mayorista, etc.).

# CÓMO COMPRAR
Completas la compra en sono.lat ($199.000 de una, o en 3 cuotas de $69.000). Después haces un
paso corto de activación (SOLO nos compartes tu QR de pagos), y cuando lo terminas despachamos
tu Sonó ya configurado, que llega en 24-48 horas. El QR es obligatorio ANTES del envío: sin él
no podemos configurarlo ni imprimir tu sticker.

# LINK DE COMPRA (darlo cuando el cliente quiere comprar)
Cuando el cliente diga que SÍ quiere pedir el suyo, que quiere comprar, o que le pases el link/dónde lo paga,
pásale SIEMPRE el enlace directo al checkout y dile que ahí completa sus datos y paga:
- Pago de una (recomendado): https://sono.lat/checkout?plan=contado
- En cuotas: https://sono.lat/checkout?plan=cuotas
Si no sabes cuál quiere, manda el de "de una" o pregúntale rápido cuál prefiere. NO inventes otros links;
solo estos dos. Mándalo escrito completo (el chat lo vuelve clicable).
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
