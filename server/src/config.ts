import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5050),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  TRUST_PROXY: z.string().optional(),

  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3307),
  DB_ADMIN_USER: z.string().min(1).default('scratchpad_admin'),
  SQLSCRATCHPAD_ADMIN_PASSWORD: z.string().min(1, 'SQLSCRATCHPAD_ADMIN_PASSWORD is required'),

  WORKSPACE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  SESSION_IDLE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  JANITOR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
  MAX_WORKSPACES: z.coerce.number().int().positive().default(50),
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
  IMPORT_TIMEOUT_MS: z.coerce.number().int().positive().default(90 * 1000),
  IMPORT_MAX_STATEMENTS: z.coerce.number().int().positive().default(60_000),
  IMPORT_BYTE_BUDGET_PER_HOUR: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 1024 * 1024),
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
