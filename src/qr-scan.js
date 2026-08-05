// Corre scanBrebImage en un worker thread para NO bloquear el event loop.
//
// Una foto de cámara (12MP) tardaba 1-2 minutos de CPU pura en la cascada de
// variantes de breb-qr.js (Jimp convolute/resize son JS puro) y congelaba el
// proceso ENTERO: pagos sin anunciar, admin y soporte colgados (incidente
// 5-ago-2026, huecos de 60-111s en el log). Las subidas de QR son esporádicas,
// así que se crea un worker por escaneo (~50ms de arranque, irrelevante) y se
// termina a los 90s por si una imagen patológica no acaba nunca.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qr-scan-worker.js');
const TIMEOUT_MS = 90_000;

/**
 * Igual que scanBrebImage pero en un hilo aparte.
 * @param {Buffer} imageBuffer
 * @returns {Promise<{qrText: string|null, decoded: object|null, isBreb: boolean}>}
 */
export function scanBrebImageOffThread(imageBuffer) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: imageBuffer });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error(`escaneo de QR superó ${TIMEOUT_MS / 1000}s, abortado`));
    }, TIMEOUT_MS);
    w.once('message', (m) => {
      clearTimeout(timer);
      w.terminate();
      if (m.ok) resolve(m.result);
      else reject(new Error(m.error));
    });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
