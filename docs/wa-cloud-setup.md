# WhatsApp Cloud API — Setup (lado Meta)

Pasos manuales (una sola vez) para activar el enviador oficial `wa-cloud.js`.
El código ya está desplegado e inerte: se enciende solo al poner las env vars.

## 1. App de Meta

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App** → tipo **Business**.
2. Vincularla al Business Manager de Sonó (el mismo de "Sonó Publisher" / el píxel).
3. En el dashboard de la app → **Add product → WhatsApp → Set up**. Esto crea la
   **WhatsApp Business Account (WABA)** automáticamente.

## 2. Registrar el número nuevo

⚠️ El número NO puede tener cuenta activa en la app de WhatsApp/WhatsApp Business.
Primero en el celular: **Ajustes → Cuenta → Eliminar cuenta** (solo borra la cuenta
de ese número nuevo, no toca el chip ni el 311).

1. App → WhatsApp → **API Setup → Add phone number**.
2. Nombre para mostrar: `Sonó` (sin verificación de negocio puede quedar pendiente
   de aprobación; mientras tanto los clientes ven el número — no bloquea nada).
3. Verificar por SMS o llamada al número nuevo.

## 3. Token permanente (system user)

1. [business.facebook.com/settings](https://business.facebook.com/settings) →
   **Users → System users → Add** (rol Admin, nombre ej. `sono-backend`).
2. **Add assets** → la app (control total) y la WABA.
3. **Generate token** → seleccionar la app → permisos:
   `whatsapp_business_messaging` + `whatsapp_business_management` →
   expiración **Never** → copiar el token (solo se muestra una vez).

## 4. IDs

En App → WhatsApp → **API Setup** copiar:
- **Phone number ID** (del número nuevo, NO el "WhatsApp Business Account ID")
- **WhatsApp Business Account ID** (WABA ID)

## 5. Env vars en la VM

Agregar a `/home/sono/backend/.env` (y `pm2 restart sono-backend`):

```
WA_CLOUD_ACCESS_TOKEN=<token del paso 3>
WA_CLOUD_PHONE_NUMBER_ID=<phone number id>
WA_CLOUD_WABA_ID=<waba id>
WA_CLOUD_WEBHOOK_VERIFY_TOKEN=<string aleatorio largo, ej. openssl rand -hex 24>
```

Al reiniciar con esto puesto: la VM envía por la Cloud API y el agente de la PC
deja de recibir cola automáticamente (guard en /wa/pending). Para volver atrás:
quitar las vars y reiniciar.

## 6. Webhook (estados reales + respuestas de clientes)

App → WhatsApp → **Configuration → Webhook**:
- Callback URL: `https://api.sono.lat/webhook/wacloud?key=<WA_CLOUD_WEBHOOK_VERIFY_TOKEN>`
- Verify token: `<WA_CLOUD_WEBHOOK_VERIFY_TOKEN>` (el mismo)
- **Webhook fields → messages → Subscribe**

El backend actualiza `wa_outbox.delivery` (sent/delivered/read/failed) por wamid
y guarda las respuestas de clientes en `wa_inbound`.

## 7. Crear las plantillas

El script es standalone (solo necesita estas 2 vars, corre local o en la VM):

```
WA_CLOUD_ACCESS_TOKEN=... WA_CLOUD_WABA_ID=... node scripts/create-wa-templates.js
```

Crea las 11 plantillas UTILITY en español (definidas en `src/wa-templates.js`).
La aprobación suele tardar minutos. Estado: business.facebook.com → WhatsApp
Manager → Plantillas de mensajes. En corridas siguientes el script detecta
**drift** (body local ≠ registrado en Meta) y lo reporta — Meta no permite
editar por API: se versiona el nombre (`_v2`) o se edita en WhatsApp Manager.

**Failsafe automático:** aunque pongas las env vars antes de tiempo, el enviador
NO se activa hasta verificar contra Meta que TODAS las plantillas están
Aprobadas (re-chequea cada 10 min). Mientras tanto el agente de la PC sigue
siendo el enviador — la cola nunca queda huérfana. El estado se ve en
`GET /admin/wa` (`cloud.active`).

## Diferencias vs el agente PC (aceptadas en v1)

- El kind `envio` ya NO adjunta el PDF de la guía (Cloud API exige plantilla con
  header DOCUMENT — pendiente `sono_guia_pdf`). El link de rastreo va en el
  mensaje de guía creada.
- Los textos que ve el cliente son los de las PLANTILLAS (`src/wa-templates.js`),
  no los de `buildWaBody` — editar `wa-enqueue.js` no cambia lo que envía la
  Cloud API. El panel muestra el body encolado (histórico del agente PC).
- Las respuestas de clientes llegan al webhook y quedan en `wa_inbound`
  (visibles en `GET /admin/wa`, campo `inbound`), no a un celular.

## Límites sin verificación de negocio

- 250 conversaciones iniciadas por Sonó cada 24 h (sobra: pico actual ~26/día).
- Al verificar el negocio: 1.000/día y escala automática.
- Costo Colombia: ~USD $0.0008 por mensaje utility (≈ $3 COP). Respuestas del
  cliente y mensajes dentro de la ventana de 24 h: gratis.
