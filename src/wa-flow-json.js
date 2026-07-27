// JSON de las pantallas del WhatsApp Flow de cuotas. Módulo SIN dependencias del
// resto del backend: lo importa src/wa-flow.js (runtime) y scripts/setup-wa-flow.js
// (que debe poder correr suelto, sin el Zod de config.js exigiendo MQTT_URL y demás).
// Mismo patrón que src/wa-templates.js.

// ── JSON del Flow (se sube a Meta con scripts/create-wa-flow.js) ───────────────
// version 7.3 + data_api_version 3.0 = Flow con endpoint (pantallas dinámicas).
export const FLOW_JSON = {
  version: '7.3',
  data_api_version: '3.0',
  routing_model: { AVISO: ['PAGO'], PAGO: [] },
  screens: [
    {
      id: 'AVISO',
      title: 'Tu cuota',
      data: {
        cuota: { type: 'string', __example__: '2' },
        total: { type: 'string', __example__: '3' },
        monto: { type: 'string', __example__: '$69.000' },
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'Cuota ${data.cuota} de ${data.total}' },
          {
            type: 'TextBody',
            text: 'Tienes pendiente ${data.monto} de tu Sonó. Toca el botón cuando vayas a pagar: te damos el QR de Bre-B al instante.',
          },
          {
            type: 'Footer',
            label: 'Voy a pagar',
            'on-click-action': { name: 'data_exchange', payload: {} },
          },
        ],
      },
    },
    {
      id: 'PAGO',
      title: 'Paga con Bre-B',
      terminal: true,
      success: true,
      data: {
        monto: { type: 'string', __example__: '$68.999' },
        qr: { type: 'string', __example__: '' },
        llave: { type: 'string', __example__: '0091787460' },
        instruccion: { type: 'string', __example__: 'Toma un pantallazo del QR…' },
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'Envía exactamente ${data.monto}' },
          {
            type: 'Image',
            src: '${data.qr}',
            height: 280,
            'scale-type': 'contain',
            'alt-text': 'Código QR de Bre-B de Sonó',
          },
          { type: 'TextCaption', text: 'Llave Bre-B: ${data.llave}' },
          { type: 'TextBody', text: '${data.instruccion}' },
          {
            type: 'Footer',
            label: 'Ya envié el pago',
            'on-click-action': { name: 'complete', payload: {} },
          },
        ],
      },
    },
  ],
};
