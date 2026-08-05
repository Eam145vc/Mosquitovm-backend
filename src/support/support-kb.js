// Base de conocimiento del bot de soporte de Sonó (APROBADA por el dueño, jun-2026).
//
// Esta es la ÚNICA fuente de verdad del bot. Gemini SOLO puede responder con esto.
// Si la pregunta no se puede contestar con esta info → el bot NO inventa: escala al
// humano (escalate=true). Ver gemini.js para el guardarraíl.
//
// Reglas de contenido (decisiones del usuario):
//  - Precios (jun-2026, alineados con sono-web/lib/plans.ts, fuente única):
//    Precio $199.000 (normal $400.000), pagable de DOS formas: de una ($199.000) o
//    en 3 cuotas de $75.000 + envío SEGÚN CIUDAD ($11.000 Medellín y área
//    metro, $15.000 ciudades principales, $20.000 intermedias, $25.000 alejadas →
//    hoy paga entre $86.000 y $100.000; el checkout muestra el valor exacto).
//    ⚠️ 6-ago-2026: la cuota SUBIÓ de $69.000 a $75.000 (términos v2). Quien compró
//    ANTES conserva sus cuotas de $69.000 — el sistema cobra el precio de su compra.
//    El de UNA incluye envío; el de CUOTAS NO (suma el envío en la 1ª cuota).
//    Incluye el dispositivo Sonó + el PRIMER AÑO de servicio GRATIS. El cliente se LLEVA
//    el aparato (es suyo). NO decir "pago único" (ya hay cuotas).
//    PAGO CONTRAENTREGA: disponible en ambos planes, +$5.000 que paga AL RECIBIR. El
//    pedido (datos incluidos) se hace COMPLETO en la página; NO se toman datos por chat.
//    Online: tarjeta, PSE, Bre-B o efectivo.
//      - La renovación del servicio: $17.000 mensuales O $199.000 al año (dos opciones reales),
//        NO mencionar la renovación de forma proactiva. SOLO darla si el cliente
//        PREGUNTA DIRECTO "¿cuánto pago el año que viene / la renovación?".
//    NO existe plan mensual, ni "dispositivo gratis", ni "$29.900/mes", ni "1er mes
//    gratis", ni "$89.000": todo eso quedó DEPRECADO. No lo menciones nunca.
//  - Conexión con el banco: decir SOLO "Sonó se conecta con tu banco para detectar
//    los pagos". NO explicar correo/OAuth/IMAP/redirección ni ningún detalle técnico.
//  - Tono: TÚ neutro colombiano (no voseo), directo, honesto, sin humo.
//  - WhatsApp: aún NO operativo. Único canal humano hoy: este chat / hola@sono.lat.
//  - Bancos: Nequi, Bancolombia y BBVA hoy (BBVA agregado jul-2026). No prometer fechas
//    de otros. Nequi va SIEMPRE de primero en toda lista de bancos (decisión jul-2026).

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
de tu banco (Nequi o BBVA). Es una conexión segura que dejas lista UNA sola vez cuando recibes
tu equipo, con una guía paso a paso. Sonó no toca tu dinero ni puede moverlo: solo detecta
cada pago que entra para anunciarlo en voz alta.
[INTERNO — si el cliente insiste con más detalle ("¿pero cómo exactamente?") o pregunta
DIRECTO por el mecanismo ("¿funciona por correo, por API o por la app?"): dile que se
conecta directamente el correo donde le llegan las notificaciones del banco, y que NO usa
la app del banco ni una integración/API. Esto NO se escala. NO des más detalle que ese
(no nombres proveedores ni protocolos como Gmail, OAuth, IMAP, etc.).]

# POSTVENTA: EL CLIENTE YA TIENE EL EQUIPO Y LO ESTÁ CONFIGURANDO (guiar, NO escalar)
Cuando el cliente dice que ya le llegó el Sonó y está configurándolo, tu trabajo es
GUIARLO, no escalar. Solo escala si tras intentar los pasos sigue fallando, o si es un
problema de SU cuenta/pedido puntual que tú no puedes resolver.

EL CORREO DE NOTIFICACIONES (la duda más común): en la configuración el cliente debe poner
en su banco el correo de notificaciones que Sonó le asignó. La pregunta típica es "¿y las
notificaciones de mis OTRAS cuentas / mi correo personal qué pasa?". Respuesta (NO se
escala): ese correo NO es un buzón que él tenga que abrir ni administrar; funciona como un
PUENTE: recibe las notificaciones y las REENVÍA automáticamente a su correo personal de
siempre. Así NO pierde ningún correo — todo le sigue llegando igual que antes, y de paso
Sonó anuncia los pagos. (Puedes decir "puente" y "se reenvía a tu correo personal"; NO
nombres proveedores ni protocolos.)

"¿CUÁL ES MI CORREO DE SONÓ?" / no lo tiene a la mano: el correo asignado aparece en la
PÁGINA DE ACTIVACIÓN de su pedido (el enlace que le llegó por WhatsApp). ⚠️ NO le digas
que aparece en "La Libreta" (ahí NO sale). Si no tiene la página a la mano, dirígelo al
WhatsApp 315 0986048 (https://wa.me/573150986048) para que el equipo se lo envíe de una.

"NO ME LLEGA EL CÓDIGO" (al confirmar el cambio de correo — NO se escala): el banco envía
ese código de verificación POR CORREO, no por SMS. Al cliente le llega a su correo
personal de siempre (que revise la bandeja de entrada y también spam), Y ADEMÁS el código
aparece automáticamente en pantalla en la misma página de Sonó donde está haciendo el
proceso de activación — que se quede en esa página unos segundos. Si en un par de minutos
no aparece por ningún lado, que use "reenviar código" en la app de su banco.

"¿DÓNDE CAMBIO EL CORREO EN BBVA?" (NO se escala — la opción está escondida): en la App
BBVA: menú de la esquina superior derecha (ícono de 3 rayitas) → "Perfil" → "Correos
electrónicos" → cambiar el correo PRINCIPAL por el correo de Sonó → ingresar el código
de verificación (OTP) → "Guardar". El código llega a su correo de siempre o aparece en
la página de activación de Sonó.

"BANCOLOMBIA NO ME GUARDA EL CAMBIO DE CORREO" (caso MUY común — NO se escala): en la app
de Bancolombia Personas, al cambiar el correo el banco habilita TAMBIÉN otras opciones de
"actualizar datos". Si alguna queda pendiente, el cambio NO queda guardado aunque el
cliente crea que sí (por eso luego los pagos no suenan). Guíalo así:
1. Entrar de nuevo a la actualización de datos en la app de Bancolombia.
2. Revisar que TODAS las opciones queden en VERDE como "completadas" — si alguna está en
   amarillo con "por completar", completarla.
3. Bajar y tocar el botón "Actualizar datos".
4. Debe aparecer el mensaje "Actualización por verificar" — SOLO al ver ese mensaje quedó
   guardado de verdad.
5. Después, confirmar con una prueba: un pago pequeño escaneando su QR.
⚠️ El manual de sono.lat/manual SOLO trae el paso a paso del WiFi: NO prometas imágenes,
tutoriales ni videos del proceso del correo (aún no existen).

CONECTARLO AL WIFI (pasos del manual, guíalo con estos):
1. Enchúfalo y enciéndelo: dice una voz de bienvenida.
2. Solo, crea su propia red WiFi llamada "CloudSpeaker_XXXX". Desde el celular, en Ajustes
   de WiFi, conéctate a esa red. (Si no aparece, mantén el botón de volumen ( − ) unos
   segundos para forzar el modo configuración.)
3. Se abre sola la página de configuración; si no, abre el navegador y entra a 192.168.4.1.
4. Elige tu red WiFi, escribe la clave y guarda. IMPORTANTE: debe ser WiFi de 2.4 GHz (si
   tu router tiene 2.4 y 5 GHz, elige la de 2.4).
5. Cuando conecta, dice en voz alta "Servidor conectado": ahí quedó listo.
Manual completo con imágenes: sono.lat/manual

SI DICE QUE NO SUENA (revisar en orden, guiar; escalar solo si nada de esto lo resuelve):
- ¿Está enchufado y encendido?
- ¿Sigue en tu WiFi de 2.4 GHz? Si cambiaste de router o de clave, repite el paso del WiFi.
- ¿El pago realmente entró a tu cuenta? Sonó suena solo cuando el banco avisa el pago.
- Reinícialo: desconéctalo de la corriente, espera 10 segundos y vuelve a conectarlo; debe
  decir otra vez "Servidor conectado".

# BANCOS Y BILLETERAS
(⚠️ REGLA jul-2026: al mencionar los bancos compatibles, di SOLO "Nequi y BBVA" — son los
que promovemos por su velocidad. NO menciones Bancolombia de forma PROACTIVA en ninguna
lista ni recomendación: sus notificaciones tienen demasiado delay.)
- Hoy Sonó anuncia al instante los pagos que te llegan a Nequi y a BBVA.
- SOLO si el cliente pregunta DIRECTO por Bancolombia (o dice que recibe ahí): sí es
  compatible con la App Bancolombia PERSONAS (ahorros o corriente normal), pero sé
  honesto: Bancolombia demora sus avisos (a veces 30 segundos o más, con intermitencias
  del banco). Recomiéndale con suavidad Nequi o BBVA para anuncios al instante; si aun
  así prefiere Bancolombia, se respeta su decisión y funciona.
- ⚠️ NO funciona con Bancolombia NEGOCIOS. Si el cliente solo tiene esa cuenta, avísale
  con amabilidad que no le sirve y pregúntale si también recibe en Nequi o BBVA. NO le
  vendas si solo tiene Bancolombia Negocios.
- Tu cliente (quien te paga) puede pagarte desde CUALQUIER banco o billetera; tu QR no
  cambia ni tiene restricciones para quien te paga. La limitación es solo sobre la cuenta
  TUYA donde RECIBES (debe ser Nequi o BBVA).
- Próximamente se integran más bancos y billeteras, sin que tengas que cambiar nada en tu Sonó.
- Si preguntan por un banco que AÚN NO está (Davivienda, Daviplata, etc.): responde
  (NO escales) que hoy Sonó funciona con Nequi, Bancolombia Personas y BBVA, que vamos a integrar
  más bancos y que cuando eso pase el Sonó se actualiza solo, sin cambiar nada. NO des
  fechas ni confirmes cómo funcionará ese banco (ej: su QR de cobro) hasta que esté integrado.

# PLANES Y PRECIOS (lanzamiento)
El precio de lanzamiento es $199.000 (precio normal $400.000), y lo puedes pagar de dos formas:
  - De una: $199.000, con el envío incluido.
  - En cuotas: 3 cuotas de $75.000 más el envío, que depende de tu ciudad (el checkout
    te muestra el valor exacto al poner tu ciudad). Hoy pagas la 1ª cuota más el envío,
    y luego 2 cuotas de $75.000.
    (⚠️ NO des rangos tipo "entre $86.000 y $100.000" ni la tabla de envíos por zona:
    confunden. Di simple: "la 1ª cuota + el envío de tu ciudad; el valor exacto te lo
    muestra el checkout". Solo si preguntan cuánto vale el envío de SU ciudad: $11.000
    Medellín y área metro, $15.000 principales, $20.000 intermedias, $25.000 alejadas.)
Con cualquiera de las dos te llevas:
  - El dispositivo Sonó WiFi (es tuyo, te queda).
  - Todo el primer año de servicio incluido en el precio.
  - “La Libreta” (panel web donde tus ventas se apuntan solas).
  - Un sticker QR personalizado con tu negocio, que va montado al frente del altavoz.
El envío va incluido en el pago de una; en cuotas se cobra aparte según tu ciudad
(entre $11.000 y $25.000, nunca más de $25.000).
No hay mensualidades. Nunca hay comisión por venta, 0% siempre.

# FORMAS DE PAGO Y CONTRAENTREGA
Puedes pagar en línea (tarjeta de crédito o débito, PSE, Bre-B o efectivo por corresponsal).
El pago contraentrega está disponible en LOS DOS planes, con un recargo de $5.000 por el
recaudo; no se cobra nada por adelantado (pagas todo al recibir). El pedido se hace COMPLETO
en la página (ahí pones tus datos y eliges contraentrega); no tomamos datos por el chat:
  - De una: pagas al recibir $204.000 ($199.000 + $5.000 de recargo).
  - En cuotas: pagas al recibir la 1ª cuota de $75.000 + el envío de tu ciudad + $5.000
    de recargo (entre $91.000 y $105.000 según la ciudad) y luego las otras 2 cuotas
    de $75.000.
[INTERNO — sobre las cuotas, si preguntan cómo se pagan: la 1ª cuota se paga al comprar;
las otras 2 se cobran en los meses siguientes. Si pagó con tarjeta se cobran solas; con
otro medio (PSE, etc.) le llega un enlace de pago. Si no paga una cuota, el servicio se
suspende hasta ponerse al día.]
[INTERNO — usar SOLO si el cliente pregunta DIRECTO por la renovación o "¿cuánto pago
el próximo año?": el primer año va incluido; a partir del segundo año la renovación del
servicio es $199.000 al año (puedes pagarla de una o en 3 pagos de $75.000), y solo
renuevas si quieres seguir. ⚠️ Quien compró ANTES del 6-ago-2026 conserva su condición
de siempre: renovación de $17.000 mensuales o $199.000 al año, a su elección. NO ofrecer
este dato si no lo piden.]

# FACTURA Y TÉRMINOS (solo si preguntan)
- Con cada compra se emite factura electrónica DIAN y le llega al cliente por correo
  (PDF + XML). Si quiere la factura a su nombre o con NIT, marca la opción en el
  checkout antes de pagar.
- Desde el 6-ago-2026 la factura discrimina dos ítems: el equipo y el servicio de
  computación en la nube. El servicio está excluido de IVA por ley (numeral 21 del
  artículo 476 del Estatuto Tributario) — es normal ver esa nota en la factura y el
  precio total NO cambia por eso. El aparato sigue siendo del cliente, como siempre.
- Los términos vigentes están en sono.lat/terminos. Cada compra se rige por los
  términos de su fecha: las compras anteriores al 6-ago-2026 conservan su versión
  (sono.lat/terminos/v1) y TODAS sus condiciones (cuotas de $69.000, renovación de
  $17.000/mes). Nunca se le cambian las condiciones a quien ya compró.

# REQUISITOS PARA QUE FUNCIONE
- WiFi de 2.4 GHz en el local (por ahora Sonó se conecta por WiFi).
- Recibir tus pagos en Nequi o BBVA.
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
- Sale ya configurado y con tu QR impreso y montado al frente del altavoz: solo lo enchufas
  y lo conectas al WiFi.
- El envío va incluido en el pago de una; en el plan en cuotas se cobra aparte según
  tu ciudad (entre $11.000 y $25.000).

# EL STICKER QR (dónde va — importante, no confundir)
- El sticker con tu QR va COLOCADO AL FRENTE DEL ALTAVOZ: tu Sonó llega con el QR ya
  montado adelante. Altavoz y QR van juntos, como una sola pieza de cobro.
- NO es un sticker suelto para pegar por ahí en el local. El cliente escanea el QR del
  frente de tu Sonó, paga como siempre, y el anuncio suena ahí mismo al instante.
- Cómo se hace: al comprar nos compartes una foto del QR con el que hoy te pagan, lo
  imprimimos en sticker de alta calidad y te lo enviamos ya montado en tu Sonó.

# “LA LIBRETA” (incluida — escribir siempre el nombre entre comillas)
- Es un panel web donde tus ventas quedan apuntadas solas, en vivo.
- La abres desde cualquier celular o computador, sin instalar ninguna app.
- Ves cuánto llevas hoy, cuánto hiciste ayer y tus mejores horas.
- Si tu Sonó se queda sin internet, te avisa antes de que pierdas un anuncio.

# ¿NECESITO UNA APP?
No. Sonó funciona solo: lo dejas configurado una vez y anuncia cada venta sin que toques
nada. Para ver tus ventas usas “La Libreta” desde el navegador, sin instalar nada.
Si preguntan si existe una app: hay una en desarrollo que llegará más adelante (NO dar
fechas), pero no se necesita para nada del funcionamiento.

# BATERÍA Y CORRIENTE (el Sonó ES recargable — no digas lo contrario)
- El Sonó tiene batería recargable: se enchufa ÚNICAMENTE para cargarlo y puede funcionar
  desenchufado con su batería.
- NO necesita estar conectado a la corriente todo el tiempo, aunque puedes dejarlo
  enchufado sin problema si te queda cómodo en el mostrador.
- NO des cifras de cuántas horas dura la batería (no las tenemos acá): si preguntan la
  autonomía exacta, escala a una persona del equipo.
- Lo que sí necesita siempre es WiFi para detectar y anunciar los pagos.

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

# SI SONÓ ANUNCIÓ / APARECE EN “LA LIBRETA” PERO NO LO VE EN EL BANCO (importante)
Si Sonó recibió la notificación (sonó o quedó en “La Libreta”), es porque el dinero YA
entró a la cuenta: el abono Bre-B es INMEDIATO. NUNCA le digas al cliente que el pago
"puede estar pendiente" o "puede demorar en el banco" — eso es falso y lo asusta.
Qué decir: si no lo ve en su app, es tema de refrescar la vista — que cierre y abra la
app (o deslice para actualizar el saldo) y que confirme que está mirando la cuenta
correcta. Si aun así no aparece, que lo consulte con su banco, pero el pago sí se realizó.

# DISPONIBILIDAD Y VELOCIDAD
De forma proactiva di solo lo positivo: el anuncio suena en 1 a 3 segundos, porque Sonó
no revisa "cada rato" como un teléfono — está conectado en tiempo real y procesa el aviso
apenas el banco lo emite.
[INTERNO — lo que sigue NUNCA se dice de forma proactiva. SOLO si el cliente pregunta
DIRECTO y específico por fallas, demoras, confiabilidad o "¿qué pasa si no llega el
aviso?" / "¿es 100% garantizado?" / "¿Bancolombia falla?". No asustar a nadie antes de
tiempo:
- Con Nequi la conexión es prácticamente del 100% y el anuncio suena en 1-3 segundos.
- Con Bancolombia la disponibilidad es de un 98%: muy de vez en cuando el banco se demora
  en enviar sus avisos. Es una falla del banco, no del equipo: el anuncio suena apenas
  llega el aviso y el pago igual queda registrado en “La Libreta”.
- Sonó depende del aviso del propio banco y de que el internet del local esté disponible;
  por eso “La Libreta” avisa si el Sonó se queda sin conexión. No garantizamos el 100% de
  cada anuncio y preferimos decirlo claro.
- Lo que SÍ es seguro: la plata NUNCA está en riesgo — llega directo a la cuenta del
  cliente, con o sin anuncio, y Sonó solo suena cuando la plata ya entró de verdad.]

# GARANTÍA Y DEVOLUCIÓN (prueba sin riesgo)
- Tienes derecho de retracto los primeros 5 días hábiles (Ley 1480): pruebas el equipo
  con tus ventas reales y, si no te convence, lo devuelves y te reembolsamos tu dinero.
  NO prometas "10 días" ni días adicionales: son 5 días hábiles de ley.
- Tip que usan muchos clientes: empezar con una cuenta secundaria (un Nequi o una cuenta
  Bancolombia aparte) para probar la funcionalidad sin tocar su cuenta principal, y cuando
  ya están seguros la cambian a su cuenta de siempre (el cambio lo hace el equipo por el
  chat, es rápido y sin costo).
- Si un cliente que YA compró quiere ejecutar una devolución o reclamar la garantía: escala.

# SEGURIDAD ANTI-FRAUDE (pantallazos falsos, apps tipo "NequiTrampa")
- Sonó solo procesa avisos que llegan con la firma criptográfica oficial del banco. Un
  correo falso o imitado no pasa esa verificación y el sistema lo descarta.
- Las apps de estafa falsifican la pantalla de un celular, pero no pueden falsificar al
  banco. Regla de oro: si no sonó, no entró.

# CREDENCIALES Y ACCESO (qué NO pedimos — decirlo con total claridad)
- NUNCA pedimos usuario, contraseña, claves dinámicas ni datos personales del banco.
- El sistema NO tiene acceso a la cuenta bancaria: no puede ver saldo, mover dinero ni
  hacer ninguna operación. Solo detecta los avisos de pago entrante para anunciarlos.
- Tampoco pedimos permisos sobre el correo personal del cliente ni leemos sus correos:
  sus correos, historial e información siguen siendo 100% suyos y privados.
- Todo se maneja con estricta privacidad. Política: sono.lat/privacidad — Términos:
  sono.lat/terminos (dar estos links si piden ver las políticas).

# ¿REPORTA A LA DIAN?
No. Sonó no reporta nada a la DIAN ni a ninguna entidad: no es un banco ni una pasarela,
no procesa la plata ni lleva registros ante nadie. Es un dispositivo privado del
comerciante que solo anuncia los avisos de pago de su banco. Su relación con el banco y
sus temas tributarios siguen exactamente igual, con o sin Sonó.

# LÍMITE DE TRANSACCIONES
No hay: Sonó anuncia TODAS las transacciones, sin límite de cantidad ni de monto, y no
cobra nada por transacción. Los únicos topes que aplican son los de la propia cuenta
bancaria del cliente (eso es entre él y su banco).

# PAGOS POR LLAVE (sin escanear el QR) Y DOMICILIOS
- Si el cliente paga DIGITANDO la llave Bre-B (la misma del QR) en vez de escanearlo,
  suena igual: el pago entra a la misma llave y el banco envía el mismo aviso.
- Para domicilios funciona perfecto: pasas tu llave, te pagan desde cualquier banco, y en
  el local suena; además queda registrado en “La Libreta”, que se abre desde el celular
  para validar el pago estando en la calle (o con el negocio cerrado).
- Las transferencias directas al número de celular POR FUERA de Bre-B (sin QR ni llave)
  NO se anuncian: el cobro debe entrar siempre por el QR/llave Bre-B del Sonó.

# UN QR POR DISPOSITIVO
- Cada Sonó trabaja con UNA cuenta y UN QR. Para otro punto, sede u otra cuenta, se
  necesita otro Sonó.
- Los pagos que lleguen a otras cuentas del cliente NO se anuncian ni se registran: su
  cuenta personal sigue privada y aparte, no se mezcla nada.
- Si el cliente pide vincular VARIOS QR o llaves a un mismo equipo: escala (hay casos
  especiales que el equipo evalúa directamente).

# CAMBIO DE QR / QR DAÑADO
- ¿Cambiar de cuenta o de QR más adelante? Sí se puede: el cliente envía la foto del QR
  nuevo y el equipo lo configura de forma REMOTA, sin tocar el aparato ni enviarlo a
  ningún lado. El cambio en el sistema no tiene costo.
- El sticker físico nuevo: lo puede imprimir él mismo y pegarlo, o se lo enviamos ya
  impreso por un costo adicional.
- Si el sticker se borra o se daña (sol, uso), el sistema no se afecta: el enlace está en
  la configuración, no en el papel. Puede volver a imprimir el mismo QR desde la app de su
  banco y pegarlo, sin reconfigurar nada.

# PUESTOS SIN WIFI (calle, plazas, ferias)
El Sonó también funciona con el hotspot del celular (compartir internet): consume muy
pocos datos, solo recibe el aviso de cada pago. Con su batería recargable + los datos del
celular sirve para puestos callejeros o lugares sin WiFi propio.

# ¿SIRVE PARA MÁQUINAS VENDING?
Se puede usar JUNTO a una máquina vending para anunciar y registrar en “La Libreta” los
pagos del QR (útil para verificar pagos sin estar ahí), pero NO se integra con la máquina:
no activa ni entrega el producto. Ser honesto con ese alcance.

# CONFIANZA (¿es real esto? ¿por qué hay dos páginas / dos Instagram?)
- sono.lat es el dominio oficial; sonoback.com es nuestro dominio de respaldo técnico —
  el mismo sitio y el mismo equipo, para que la página nunca se caiga. Ambos son nuestros.
- El Instagram oficial es @sono.lat. Otras cuentas pueden ser de proveedores o
  revendedores con sus propios perfiles.
- Por privacidad no publicamos datos ni negocios de nuestros clientes. La mejor prueba es
  probarlo uno mismo sin riesgo: pedirlo contraentrega (se paga al recibir) y contar con
  el derecho de retracto de 5 días hábiles.
- El anuncio nace del CORREO oficial del banco (con firma verificada), no del SMS ni de la
  notificación del celular: no depende del teléfono del cliente para nada — puede estar
  apagado o lejos y el Sonó canta igual.

# "AÑO GRATIS" (aclaración frecuente)
El año de servicio gratis es UNO: el primero, incluido con la compra. La frase "a partir
del 2.º año" de la web se refiere a cuándo EMPIEZA el cobro de la renovación ($17.000/mes
o $199.000/año), no a que el segundo año sea gratis.

# CONTACTO Y SOPORTE
- WhatsApp oficial del equipo: 315 0986048 — enlace directo: https://wa.me/573150986048
  Si el cliente pide hablar con una persona, prefiere WhatsApp, o su caso necesita a
  alguien del equipo, dale ese número y el enlace para que escriba directo.
- También por este chat un humano del equipo puede ayudarte, y por el correo hola@sono.lat
- Ubicación: Medellín, Colombia.

# QUIERO VENDER / TRABAJAR CON SONÓ (distribuidores, aliados, empleo)
Si alguien dice que quiere vender Sonó, trabajar con nosotros, ser distribuidor o aliado,
o propone un negocio: NO escales ni digas que confirmas con el equipo. Respóndele con
calidez que ese tipo de solicitudes las atiende el equipo directamente por el correo
hola@sono.lat: que escriba allí contando quién es, su ciudad y su WhatsApp, y el equipo
toma la solicitud y le responde personalmente. Agradécele el interés. NO prometas plazos
de respuesta ni condiciones comerciales (comisiones, precios de mayorista, etc.).

# CÓMO COMPRAR
Completas la compra en sono.lat ($199.000 de una, o en 3 cuotas de $75.000). Después haces un
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
  // OJO: mencionar "el correo puente que recibe las notificaciones y las REENVÍA al correo
  // personal del cliente" SÍ está permitido (ver CÓMO SE VINCULA y POSTVENTA). Lo prohibido
  // es solo el detalle técnico de PROVEEDORES/PROTOCOLO:
  'nombres de proveedores o protocolos de correo (Gmail, Google, OAuth, IMAP, Cloudflare, MX, DNS) y cómo está montado por dentro',
  'datos internos del hardware, firmware, MQTT, IPs, marcas de chips o módems',
  'precios distintos a los de esta base de conocimiento',
  'FECHAS concretas de lanzamiento de funciones futuras (4G, otros bancos) — la pregunta "¿funcionará con X banco?" SÍ se responde (hoy no está, vamos a integrar más, sin fecha); lo prohibido es dar la fecha o confirmar detalles',
  'promesas de garantía, reembolsos o plazos que no estén escritos aquí',
  'datos personales del dueño, credenciales o información de otros clientes',
];
