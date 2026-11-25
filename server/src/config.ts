import { isIP } from 'node:net';
import { z } from 'zod';

function isValidIpOrCidr(entry: string): boolean {
  const slashIdx = entry.indexOf('/');
  if (slashIdx === -1) {
    return isIP(entry) !== 0;
  }
  const addr = entry.slice(0, slashIdx);
  const prefixStr = entry.slice(slashIdx + 1);
  if (!/^\d+$/.test(prefixStr)) return false;
  const ipVer = isIP(addr);
  if (ipVer === 0) return false;
  const prefix = Number(prefixStr);
  return ipVer === 4 ? prefix >= 0 && prefix <= 32 : prefix >= 0 && prefix <= 128;
}

export function parseTrustProxy(raw?: string): string[] | false {
  if (!raw || raw.trim() === '') return false;
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return false;
  for (const entry of entries) {
    if (!isValidIpOrCidr(entry)) {
      throw new Error(`TRUST_PROXY entry "${entry}" is not a valid IP address or CIDR range`);
    }
  }
  return entries;
}

export function parseIpAllowList(raw?: string): Set<string> {
  if (!raw || raw.trim() === '') return new Set();
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of entries) {
    if (isIP(entry) === 0) {
      throw new Error(`IP allowlist entry "${entry}" is not a valid IP address`);
    }
  }
  return new Set(entries);
}

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(5050),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: z
      .string()
      .optional()
      .refine(
        (val) => {
          try {
            parseTrustProxy(val);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'TRUST_PROXY must be empty or a comma-separated list of IP addresses / CIDRs' },
      ),

    DB_HOST: z.string().min(1).default('127.0.0.1'),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(3307),
    DB_ADMIN_USER: z.string().min(1).default('scratchpad_admin'),
    SQLSCRATCHPAD_ADMIN_PASSWORD: z
      .string()
      .min(1, 'SQLSCRATCHPAD_ADMIN_PASSWORD is required')
      .refine((val) => !/^(?:replace-with-|changeme$|change-me$|password$)/i.test(val.trim()), {
        message: 'SQLSCRATCHPAD_ADMIN_PASSWORD must not use a placeholder value',
      }),

    WORKSPACE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(2 * 60 * 60 * 1000),
    WORKSPACE_MAX_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(12 * 60 * 60 * 1000),
    SESSION_IDLE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),
    JANITOR_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60 * 1000),
    MAX_WORKSPACES: z.coerce.number().int().positive().default(50),
    MAX_WORKSPACES_PER_IP: z.coerce.number().int().positive().default(6),
    IPV6_PREFIX_BITS: z.coerce.number().int().min(1).max(128).default(64),
    LOADTEST_ALLOW_IPS: z
      .string()
      .optional()
      .refine(
        (val) => {
          try {
            parseIpAllowList(val);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'LOADTEST_ALLOW_IPS must be empty or a comma-separated list of IP addresses' },
      ),
    MAINTENANCE: z
      .string()
      .optional()
      .transform((v) => v === '1' || v?.toLowerCase() === 'true'),
    MAX_WORKSPACE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    MAX_TOTAL_WORKSPACE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(1024 * 1024 * 1024),
    ROW_CAP: z.coerce.number().int().positive().default(1000),
    RESPONSE_CAP_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    EXEC_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 1000),
    EXEC_MAX_STATEMENTS: z.coerce.number().int().positive().default(500),
    IMPORT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(75 * 1000),
    IMPORT_MAX_STATEMENTS: z.coerce.number().int().positive().default(60_000),
    IMPORT_BYTE_BUDGET_PER_HOUR: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 1024 * 1024),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production' && parseIpAllowList(data.LOADTEST_ALLOW_IPS).size > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOADTEST_ALLOW_IPS'],
        message: 'LOADTEST_ALLOW_IPS must not be set when NODE_ENV=production',
      });
    }
  });

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
