// Entry del worker thread que corre el escaneo de QR fuera del event loop
// principal. Ver qr-scan.js para el porqué. Recibe el buffer de la imagen en
// workerData y responde una sola vez por postMessage.
import { parentPort, workerData } from 'node:worker_threads';
import { scanBrebImage } from './breb-qr.js';

try {
  const result = await scanBrebImage(workerData);
  parentPort.postMessage({ ok: true, result });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e?.message || String(e) });
}
