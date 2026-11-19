import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
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
  'req.remoteAddress',
  'remoteAddress',
];

function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Computes a truncated, salted SHA-256 hash of a client IP.
 * Salt is generated randomly per process start and rotated daily (UTC) in memory only.
 */
export class IpHasher {
  private currentDay: string;
  private salt: Buffer;

  constructor(now: Date = new Date()) {
    this.currentDay = utcDayKey(now);
    this.salt = randomBytes(32);
  }

  hash(ip: string, now: Date = new Date()): string {
    const day = utcDayKey(now);
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.salt = randomBytes(32);
    }
    return createHash('sha256')
      .update(this.salt)
      .update('\0')
      .update(ip)
      .digest('hex')
      .slice(0, 16);
  }
}

export function buildLoggerOptions(
  level: string,
  ipHasher: IpHasher = new IpHasher(),
  stream?: NodeJS.WritableStream,
): LoggerOptions {
  return {
    level,
    ...(stream ? { stream } : {}),
    redact: {
      paths: PINO_REDACT_PATHS,
      censor: '[REDACTED]',
    },
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: request.url,
          clientIpHash: ipHasher.hash(request.ip || 'unknown'),
        };
      },
    },
  };
}

export function sqlLogMeta(sql: string): { sqlLength: number; sqlSha256: string } {
  return {
    sqlLength: sql.length,
    sqlSha256: createHash('sha256').update(sql).digest('hex').slice(0, 16),
  };
}
