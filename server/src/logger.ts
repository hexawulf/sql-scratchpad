import { createHash } from 'node:crypto';
import type { LoggerOptions } from 'pino';

export const PINO_REDACT_PATHS = [
  'sql',
  '*.sql',
  'req.body.sql',
  'body.sql',
  'password',
  '*.password',
  'SQLSCRATCHPAD_ADMIN_PASSWORD',
  'MARIADB_ROOT_PASSWORD',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function buildLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: PINO_REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };
}

export function sqlLogMeta(sql: string): { sqlLength: number; sqlSha256: string } {
  return {
    sqlLength: sql.length,
    sqlSha256: createHash('sha256').update(sql).digest('hex').slice(0, 16),
  };
}
