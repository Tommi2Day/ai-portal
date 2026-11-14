import pino, { type DestinationStream, type LogFn } from 'pino';
import { config } from './config.js';
import { maskString, redactDeep } from './redact.js';

/**
 * Structured JSON to stdout — picked up by Loki / ELK / Splunk.
 * Everything that is logged passes through redact.ts: secret-looking fields are replaced, credentials inside
 * strings (bearer tokens, URL passwords, secret query parameters, JWTs) are masked and errors are reduced to
 * type, message, stack, code and status.
 */
export function createLogger(dest?: DestinationStream, level: string = config.LOG_LEVEL) {
  return pino({
    level,
    base: { service: 'ai-portal' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { log: (o) => redactDeep(o) as Record<string, unknown> },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((a) => (typeof a === 'string' ? maskString(a) : a)) as Parameters<LogFn>);
      },
    },
  }, dest);
}

export const logger = createLogger();
