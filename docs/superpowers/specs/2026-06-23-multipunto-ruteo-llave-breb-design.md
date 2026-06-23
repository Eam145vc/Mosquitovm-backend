# Sonó multipunto — ruteo de pagos por llave Bre-B

Fecha: 2026-06-23
Estado: aprobado (diseño), pendiente de plan de implementación.

## Problema

Un comerciante con varios locales usa **la misma cuenta bancaria** pero **un solo correo
de banco** (en el banco no puede / no quiere configurar dos reenvíos distintos). Cuando
llega un pago a ese correo, el sistema debe anunciarlo en el speaker del **local correcto**.

Caso real: Jhon Fredy compró 2 dispositivos (2 locales), ambos en su cuenta y su correo
`fredy2585@yahoo.com`, ya unificados al mismo alias de Sonó (`fredy2585-3785@sono.lat`).

## Hallazgo clave (verificado con datos reales)

Las llaves Bre-B (Banco de la República) son **únicas globalmente**: una llave se asocia a
una sola cuenta/entidad, y una cuenta puede tener varias llaves. Hay 4 tipos: alfanumérica
`@texto`, celular, cédula, correo.

**La misma llave viaja en DOS lugares**, lo que permite el ruteo:

1. **En el email de pago de Bancolombia** (texto plano), ej:
   > "...recibiste un pago de EMMANUEL ALVAREZ MARTINEZ por $100.00 en tu cuenta **\*4369**
   > conectado a la llave **@test883**..."

2. **En el QR EMVCo** que el cliente sube, dentro del **tag 26** (namespace `CO.COM.RBM.LLA`):
   - QR con llave alfanumérica → `26.04 = "@jhon437203"`
   - QR por cuenta/numérica → `26.05.00 = "353497"` + `50.01 = "0029353497"`

Ambos QR reales de Jhon fueron decodificados (jsQR + parser TLV) y confirman esta estructura.
Por eso: **al subir el QR extraemos la llave automáticamente; al llegar un pago, el parser
extrae la llave del email; se hace match → speaker correcto.**

## Ejemplo de QR EMVCo decodificado (real, QR 2 de Jhon)

```
00 = "01"                      (payload format)
01 = "11"                      (dynamic/static)
26 (template)                  (merchant account info — LLAVE Bre-B)
  26.00 = "CO.COM.RBM.LLA"
  26.04 = "@jhon437203"        ← LA LLAVE (alfanumérica)
49.01 = "RBM"                  (red = Bre-B)
50.01 = "00000000"            (cuenta)
51.01 = "0"                    (...)
59 = "0"                       (nombre comercio)  [en el QR 1: "Supermercado pa mi gen"]
62.07 = "CC80144372"           (cédula del titular)
90 = "...TRXID..."             (id transacción)
91 = "...SEC..."               (firma del banco)
63 = "6E"                      (CRC)
```

## Comportamiento (la lógica que funciona)

- **Cliente con 1 solo local** (mayoría): suena siempre en su único speaker. NO se mira la
  llave. Retrocompatible: los clientes actuales siguen igual.
- **Cliente con 2+ locales**: se rutea por la llave del pago.
  - Llave del email coincide con la `breb_key` de un device de la cuenta → suena en ESE speaker.
  - 0 coincidencias (llave desconocida, o email sin llave parseable) → **NO suena** (para no
    confundir) + se registra un **aviso en el panel** del usuario (panel aún por construir;
    por ahora el aviso queda persistido + en logs).
  - >1 coincidencia (no debería pasar, la llave es única): fail-safe = suena en todos los que
    matchean + log warning.

## Componentes

### A. Decodificador de QR EMVCo → JSON — `src/breb-qr.js` (nuevo)
- Entrada: buffer de imagen (PNG/JPG) del QR.
- Lee el QR (jsQR + jimp) → string EMVCo → parsea TLV (con templates anidados) → objeto.
- Extrae y devuelve: `{ key, keyType, account, merchantName, raw, tlv }`.
  - `key`: la llave normalizada (minúsculas, trim; `@` se conserva). De tag 26 (subtag 04
    para `@`, o el identificador del subtag correspondiente para celular/cédula/cuenta).
  - `merchantName`: tag 59. `account`: tag 50/51.
  - `raw`: el string EMVCo completo (para regenerar el QR de impresión).
- Si no se puede leer el QR o no hay tag 26 → devuelve `null` (el caller maneja el error).

### B. Parser de pago amplía extracción de llave — `src/parsers/bancolombia.js`
- Hoy devuelve `{ amount, currency, bank, ref, direction }`.
- Se agrega extracción de:
  - `brebKey`: regex sobre el texto `conectado a la llave\s+(@?\S+)` (cubre `@alias`,
    celular, cédula, correo).
  - `account`: regex `cuenta\s+\*?(\d{3,})` → últimos dígitos.
- Devuelve además `{ brebKey, account }` (null si no aparecen). NO rompe el formato actual.

### C. Schema — `src/storage.js`
- Columnas nuevas en `devices` (vía `ensureColumns`, migración no destructiva):
  - `breb_key TEXT` — llave normalizada del local (del QR).
  - `breb_qr_json TEXT` — JSON decodificado del QR (incl. `raw` EMVCo, para regenerar).
  - `local_name TEXT` — nombre del comercio (tag 59 del QR).
- Helpers nuevos: `setDeviceBrebKey(spkrId, { key, qrJson, localName })`,
  `listDevicesByAccount(accountId)`, `findDeviceByKey(accountId, key)`.

### D. Ruteo — `src/http-server.js` (webhook `/webhook/email`, ~línea 1575)
- Reemplaza `speakerId: account.speaker_id` por una función `pickSpeaker(account, payment)`:
  - devices = `listDevicesByAccount(account.id)`.
  - si devices.length <= 1 → `account.speaker_id` (comportamiento actual).
  - si 2+ → `findDeviceByKey(account.id, normalize(payment.brebKey))`:
    - match → ese `spkr_id`.
    - sin match → retorna `null` → NO se llama announcePayment; se registra aviso
      (`saveUnroutedPayment` o reusar inbox/announce-log con flag) + log warning.

### E. Guardar la llave al subir el QR — `src/http-server.js` (endpoint POST QR, ~línea 790)
- Tras guardar el archivo del QR, decodificarlo con `breb-qr.js`.
- Si trae llave → `setDeviceBrebKey` en el device de esa orden (si la orden ya tiene device
  asignado; si no, se guarda en la orden y se transfiere al device al asignarlo).
- Si el QR no decodifica → seguir guardando el archivo (no romper el onboarding), pero
  loguear que no se pudo extraer la llave (el ruteo de ese local quedará pendiente).

### F. Regenerar QR para impresión (preparado, no bloqueante)
- Con `breb_qr_json.raw` (string EMVCo original) se regenera el QR para imprimir la etiqueta.
- Conecta con la impresora de etiquetas existente (4BARCODE). Se especifica aparte; aquí solo
  se garantiza que el `raw` quede guardado.

## Casos límite

- **Device sin llave aún** (QR no subido): no participa del match. Con 1 device → suena igual.
- **Formato de llave distinto** QR vs email (mayúsculas/espacios): se normaliza ambos antes
  de comparar (`toLowerCase().trim()`).
- **QR por cuenta sin `@`**: se usa el identificador numérico del tag 26 / cuenta; el match
  requiere que el email traiga ese dato. Si el email solo trae `@llave`, no matchea → aviso.
- **QR ilegible**: error claro en el onboarding ("sube una imagen nítida"); no se bloquea el
  guardado del archivo, pero el ruteo de ese local queda pendiente hasta tener la llave.

## Retrocompatibilidad

El cambio NO afecta a los clientes de 1 solo local (siguen con `account.speaker_id`). El
ruteo por llave solo se activa con 2+ devices en la cuenta. Migración de schema no destructiva.

## Testing

- **Unit `breb-qr.js`**: decodificar los 2 strings EMVCo reales de Jhon (fixtures) y verificar
  que extrae `@jhon437203` (QR 2) y la cuenta `0029353497` + "Supermercado pa mi gen" (QR 1).
- **Unit parser**: el email real de Bre-B → extrae `@test883` y `*4369`.
- **Unit ruteo `pickSpeaker`**: 1 device → speaker actual; 2 devices con llaves → match
  correcto; sin match → null (no suena) + aviso.
- **Normalización**: `@Test883` (QR) vs `@test883` (email) → matchean.

## Fuera de alcance (otra iteración)

- El panel del usuario donde se ven los avisos de pagos sin rutear (aún no fabricado).
- La regeneración/impresión del QR (componente F queda preparado pero la impresión se
  especifica aparte).
- Soporte de ruteo para otros bancos/billeteras (Nequi no manda la llave en el email; queda
  como antes). Esto es solo Bancolombia Bre-B.
