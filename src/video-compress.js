// Compresión de video con ffmpeg (como WhatsApp): el operario sube un video pesado
// y la VM lo reduce a <16MB antes de mandarlo por la Cloud API, sin que él tenga que
// convertir nada. H.264 720p + AAC + faststart; si sigue grande, baja bitrate/resolución.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.js';

const TARGET_BYTES = 15 * 1024 * 1024; // margen bajo el tope de 16MB de WhatsApp

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + err.slice(-300)))));
  });
}

/** Comprime un buffer de video a <~15MB. Devuelve { buffer, mime: 'video/mp4' }.
 *  Dos pasadas de calidad decreciente; si aun así no baja, lanza para avisar al usuario. */
export async function compressVideo(inputBuffer) {
  const dir = mkdtempSync(join(tmpdir(), 'wavid-'));
  const inFile = join(dir, 'in');
  const outFile = join(dir, 'out.mp4');
  writeFileSync(inFile, inputBuffer);
  // Cada intento: (escala máx alto, CRF, bitrate audio). Más agresivo si no basta.
  const attempts = [
    ['720', '28', '128k'],
    ['540', '30', '96k'],
    ['480', '32', '64k'],
  ];
  try {
    for (const [h, crf, ab] of attempts) {
      await run([
        '-y', '-i', inFile,
        '-vf', `scale=-2:'min(${h},ih)'`,   // baja a <=${h}p, mantiene proporción, ancho par
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf,
        '-c:a', 'aac', '-b:a', ab, '-movflags', '+faststart',
        outFile,
      ]);
      const size = statSync(outFile).size;
      logger.info({ h, crf, size }, 'video-compress: intento');
      if (size <= TARGET_BYTES) {
        return { buffer: readFileSync(outFile), mime: 'video/mp4' };
      }
    }
    throw new Error('el video es muy largo/pesado y no baja de 16MB ni comprimido — recórtalo un poco');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}
