import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { app: 'qr-announcer' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
