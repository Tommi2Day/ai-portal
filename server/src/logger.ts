import pino from 'pino';
import { config } from './config.js';

/** Structured JSON to stdout — picked up by Loki / ELK / Splunk. */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'ai-portal' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['*.password', '*.apiKey', '*.secretAccessKey', '*.headers.authorization', '*.headers.Authorization'],
});
