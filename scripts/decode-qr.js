// Decodifica un QR desde un archivo de imagen y muestra su contenido (texto/URL).
// Uso: node scripts/decode-qr.js <ruta-imagen>
import { Jimp } from 'jimp';
import jsQR from 'jsqr';

const file = process.argv[2];
if (!file) { console.error('uso: node scripts/decode-qr.js <imagen>'); process.exit(1); }

const img = await Jimp.read(file);
const { data, width, height } = img.bitmap;
const code = jsQR(new Uint8ClampedArray(data), width, height);
if (!code) { console.error('NO_QR: no se pudo leer un QR en la imagen'); process.exit(2); }
console.log(code.data);
