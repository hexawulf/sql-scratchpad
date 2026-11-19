import { createHash, randomBytes } from 'node:crypto';
import { isIP, isIPv4 } from 'node:net';
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

function parseIpv6ToBytes(ip: string): Uint8Array | null {
  let working = ip.toLowerCase();

  // Handle embedded IPv4 suffix (e.g. ::ffff:203.0.113.10)
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const v4Part = working.slice(lastColon + 1);
    if (!isIPv4(v4Part)) return null;
    const octets = v4Part.split('.').map((o) => Number(o));
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return null;
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dblParts = working.split('::');
  if (dblParts.length > 2) return null;

  let groups: string[];
  if (dblParts.length === 2) {
    const left = dblParts[0] ? dblParts[0].split(':') : [];
    const right = dblParts[1] ? dblParts[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  } else {
    groups = dblParts[0] ? dblParts[0].split(':') : [];
    if (groups.length !== 8) return null;
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const val = parseInt(g, 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

function isIpv4MappedBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * Unwraps IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) to plain IPv4; leaves other IPs intact.
 */
export function unwrapMappedIpv4(rawIp: string): string {
  const clean = rawIp.trim().split('%')[0] ?? '';
  if (isIP(clean) !== 6) return clean || 'unknown';
  const bytes = parseIpv6ToBytes(clean);
  if (bytes && isIpv4MappedBytes(bytes)) {
    return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  return clean;
}

/**
 * Normalises a client IP before hashing for rate limits, ownership caps, and logs:
 * - IPv4 -> as-is
 * - IPv4-mapped IPv6 (::ffff:a.b.c.d) -> plain IPv4
 * - Native IPv6 -> canonical masked prefix of `ipv6PrefixBits` (default /64)
 */
export function normalizeClientIp(rawIp: string, ipv6PrefixBits = 64): string {
  const clean = rawIp.trim().split('%')[0] ?? '';
  if (!clean) return 'unknown';
  const ver = isIP(clean);
  if (ver === 4) return clean;
  if (ver !== 6) return clean;

  const bytes = parseIpv6ToBytes(clean);
  if (!bytes) return clean;

  if (isIpv4MappedBytes(bytes)) {
    return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }

  const prefixBits = Math.max(1, Math.min(128, Math.trunc(ipv6PrefixBits)));
  const masked = new Uint8Array(16);
  const fullBytes = Math.floor(prefixBits / 8);
  const remBits = prefixBits % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    masked[i] = bytes[i]!;
  }
  if (remBits > 0 && fullBytes < 16) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    masked[fullBytes] = bytes[fullBytes]! & mask;
  }

  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((masked[i]! << 8) | masked[i + 1]!).toString(16).padStart(4, '0'));
  }
  return `${groups.join(':')}/${prefixBits}`;
}

function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Computes truncated, salted SHA-256 hashes of normalised client IPs with two independent salts:
 * - `hash(ip, now)`: log privacy hash using an in-memory random salt rotated daily (UTC).
 * - `key(ip)`: rate-limit & workspace-ownership key using a separate in-memory random salt
 *   that lives for the entire process lifetime (never rotated, never logged).
 */
export class IpHasher {
  private currentDay: string;
  private logSalt: Buffer;
  private readonly keySalt: Buffer;
  private readonly ipv6PrefixBits: number;

  constructor(now: Date = new Date(), ipv6PrefixBits = 64) {
    this.currentDay = utcDayKey(now);
    this.logSalt = randomBytes(32);
    this.keySalt = randomBytes(32);
    this.ipv6PrefixBits = ipv6PrefixBits;
  }

  hash(ip: string, now: Date = new Date()): string {
    const day = utcDayKey(now);
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.logSalt = randomBytes(32);
    }
    const normalized = normalizeClientIp(ip, this.ipv6PrefixBits);
    return createHash('sha256')
      .update(this.logSalt)
      .update('\0')
      .update(normalized)
      .digest('hex')
      .slice(0, 16);
  }

  key(ip: string): string {
    const normalized = normalizeClientIp(ip, this.ipv6PrefixBits);
    return createHash('sha256')
      .update(this.keySalt)
      .update('\0')
      .update(normalized)
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
