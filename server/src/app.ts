import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'mysql2/promise';
import type {
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DatasetMeta,
  ExecRequest,
  ExecResponse,
  HealthResponse,
  ImportRequest,
  ImportResponse,
  OkResponse,
  ResetWorkspaceRequest,
  ResetWorkspaceResponse,
  SchemaTree,
  SessionId,
} from '@sql-scratchpad/shared';
import { parseIpAllowList, parseTrustProxy, type AppConfig } from './config.js';
import { IpHasher, buildLoggerOptions, sqlLogMeta, unwrapMappedIpv4 } from './logger.js';
import { checkDbHealth, createAdminPool } from './db.js';
import { loadDatasets } from './datasets.js';
import { ApiError, fastifyErrorHandler, formatApiError } from './errors.js';
import { WorkspaceManager } from './workspace-manager.js';
import { ExecEngine } from './exec-engine.js';
import { ImportByteBudget, ImportEngine } from './import-engine.js';
import { introspectWorkspaceSchema } from './schema-introspector.js';
import { registerStaticSpa } from './static.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

export const BODY_LIMIT_BYTES = 256 * 1024;
const IMPORT_SQL_MAX_BYTES = 6 * 1024 * 1024;
const IMPORT_BODY_LIMIT_BYTES = 7 * 1024 * 1024;
const MAX_CONCURRENT_IMPORTS_GLOBAL = 2;
const MAX_CONCURRENT_IMPORTS_PER_IP = 1;

export interface BuildAppOptions {
  config: AppConfig;
  adminPool?: Pool;
  datasets?: DatasetMeta[];
  enableRateLimit?: boolean;
  startJanitor?: boolean;
  cleanupOrphansOnBoot?: boolean;
  staticDir?: string;
  ipHasher?: IpHasher;
  logStream?: NodeJS.WritableStream;
}

export interface AppContext {
  app: FastifyInstance;
  adminPool: Pool;
  datasets: DatasetMeta[];
  workspaceManager: WorkspaceManager;
  execEngine: ExecEngine;
  importEngine: ImportEngine;
  ipHasher: IpHasher;
}

const datasetBodySchema = {
  type: 'object',
  required: ['dataset'],
  additionalProperties: false,
  properties: {
    dataset: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

const wsIdParamsSchema = {
  type: 'object',
  required: ['wsId'],
  properties: {
    wsId: { type: 'string', minLength: 8, maxLength: 64, pattern: '^[a-z2-7]+$' },
  },
} as const;

const execBodySchema = {
  type: 'object',
  required: ['sql'],
  additionalProperties: false,
  properties: {
    sql: { type: 'string', maxLength: BODY_LIMIT_BYTES },
    session: { type: 'string', enum: ['A', 'B'], default: 'A' },
    stopOnError: { type: 'boolean', default: true },
  },
} as const;

const importBodySchema = {
  type: 'object',
  required: ['sql'],
  additionalProperties: false,
  properties: {
    sql: { type: 'string' },
    mode: { type: 'string', enum: ['fresh', 'append'], default: 'fresh' },
  },
} as const;

const killParamsSchema = {
  type: 'object',
  required: ['wsId', 'session'],
  properties: {
    wsId: { type: 'string', minLength: 8, maxLength: 64, pattern: '^[a-z2-7]+$' },
    session: { type: 'string', enum: ['A', 'B'] },
  },
} as const;

export async function buildApp(options: BuildAppOptions): Promise<AppContext> {
  const { config } = options;
  const ownsPool = !options.adminPool;
  const adminPool = options.adminPool ?? createAdminPool(config);
  const datasets = options.datasets ?? loadDatasets();
  const rateLimitEnabled = options.enableRateLimit !== false;
  const ipHasher = options.ipHasher ?? new IpHasher(new Date(), config.IPV6_PREFIX_BITS);
  const loadtestAllowIps = parseIpAllowList(config.LOADTEST_ALLOW_IPS);

  const app = Fastify({
    logger: buildLoggerOptions(config.LOG_LEVEL, ipHasher, options.logStream),
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: parseTrustProxy(config.TRUST_PROXY),
    connectionTimeout: 30_000,
    keepAliveTimeout: 30_000,
    requestTimeout: Math.max(90_000, config.IMPORT_TIMEOUT_MS + 15_000),
  });
  app.server.maxConnections = 256;

  app.setErrorHandler(fastifyErrorHandler);

  if (config.MAINTENANCE) {
    app.addHook('onRequest', async (req, reply) => {
      const rawPath = req.url.split('?')[0] ?? '/';
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(rawPath);
      } catch {
        return reply.code(400).send(formatApiError('BAD_REQUEST', 'Malformed URL path'));
      }
      const matchedUrl = req.routeOptions?.url;
      const isApiPath = (p: string | undefined): boolean =>
        typeof p === 'string' && (p === '/api' || p.startsWith('/api/')) && p !== '/api/health';

      if (isApiPath(rawPath) || isApiPath(decodedPath) || isApiPath(matchedUrl)) {
        return reply
          .code(503)
          .send(
            formatApiError(
              'MAINTENANCE',
              'SQL Scratchpad is temporarily down for maintenance. Please try again shortly.',
            ),
          );
      }
    });
  }

  const staticDir = options.staticDir ?? resolve(__dirname, '..', '..', 'web', 'dist');
  const staticRegistered = registerStaticSpa(app, staticDir);
  if (!staticRegistered) {
    app.setNotFoundHandler((_req, reply) => {
      void reply.code(404).send(formatApiError('NOT_FOUND', 'Route not found'));
    });
  }

  if (rateLimitEnabled) {
    await app.register(rateLimit, {
      global: false,
      keyGenerator: (req) => ipHasher.key(req.ip || 'unknown'),
      allowList: (req) => loadtestAllowIps.has(unwrapMappedIpv4(req.ip || '')),
      addHeadersOnExceeding: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true,
      },
      addHeaders: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true,
        'retry-after': true,
      },
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: {
          code: 'RATE_LIMITED',
          message: `Rate limit exceeded. Retry in ${context.after}.`,
        },
      }),
    });
  }

  const workspaceManager = new WorkspaceManager(adminPool, config, datasets, app.log);
  const execEngine = new ExecEngine(workspaceManager, config);
  const importEngine = new ImportEngine(workspaceManager, config);
  const importByteBudget = new ImportByteBudget(config.IMPORT_BYTE_BUDGET_PER_HOUR);

  let activeImportsGlobal = 0;
  const activeImportsByKey = new Map<string, number>();
  const importSlotReleases = new WeakMap<FastifyRequest, () => void>();

  const releaseImportSlot = (req: FastifyRequest): void => {
    const release = importSlotReleases.get(req);
    if (release) {
      importSlotReleases.delete(req);
      release();
    }
  };

  app.addHook('onResponse', async (req) => {
    releaseImportSlot(req);
  });
  app.addHook('onError', async (req) => {
    releaseImportSlot(req);
  });
  app.addHook('onRequestAbort', async (req) => {
    releaseImportSlot(req);
  });

  if (options.cleanupOrphansOnBoot) {
    await workspaceManager.cleanupOrphans();
  }
  if (options.startJanitor) {
    workspaceManager.startJanitor();
  }

  app.get('/api/health', async (_req, reply) => {
    const dbOk = await checkDbHealth(adminPool);
    if (config.MAINTENANCE) {
      const body: HealthResponse = {
        status: 'maintenance',
        db: dbOk ? 'ok' : 'error',
        version: PKG_VERSION,
      };
      return reply.code(200).send(body);
    }
    const body: HealthResponse = {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      version: PKG_VERSION,
    };
    return reply.code(dbOk ? 200 : 503).send(body);
  });

  app.get('/api/datasets', async () => {
    return datasets;
  });

  app.post<{ Body: CreateWorkspaceRequest }>(
    '/api/workspaces',
    {
      schema: { body: datasetBodySchema },
      config: rateLimitEnabled ? { rateLimit: { max: 20, timeWindow: '1 hour' } } : undefined,
    },
    async (req, reply): Promise<CreateWorkspaceResponse> => {
      const ownerIpHash = ipHasher.key(req.ip || 'unknown');
      const bypassPerIp = loadtestAllowIps.has(unwrapMappedIpv4(req.ip || ''));
      const created = await workspaceManager.createWorkspace(
        req.body.dataset,
        ownerIpHash,
        bypassPerIp,
      );
      void reply.code(201);
      return created;
    },
  );

  app.post<{ Params: { wsId: string }; Body: ResetWorkspaceRequest }>(
    '/api/workspaces/:wsId/reset',
    {
      schema: { params: wsIdParamsSchema, body: datasetBodySchema },
      config: rateLimitEnabled ? { rateLimit: { max: 10, timeWindow: '1 hour' } } : undefined,
    },
    async (req): Promise<ResetWorkspaceResponse> => {
      return workspaceManager.resetWorkspace(req.params.wsId, req.body.dataset);
    },
  );

  app.post<{ Params: { wsId: string }; Body: ExecRequest }>(
    '/api/workspaces/:wsId/exec',
    {
      schema: { params: wsIdParamsSchema, body: execBodySchema },
      config: rateLimitEnabled ? { rateLimit: { max: 60, timeWindow: '1 minute' } } : undefined,
    },
    async (req): Promise<ExecResponse> => {
      const execReq: ExecRequest = {
        sql: req.body.sql,
        session: req.body.session ?? 'A',
        stopOnError: req.body.stopOnError ?? true,
      };
      req.log.info(
        {
          wsId: req.params.wsId,
          session: execReq.session,
          ...sqlLogMeta(execReq.sql),
        },
        'Executing SQL batch',
      );
      return execEngine.execute(req.params.wsId, execReq);
    },
  );

  app.post<{ Params: { wsId: string }; Body: ImportRequest }>(
    '/api/workspaces/:wsId/import',
    {
      bodyLimit: IMPORT_BODY_LIMIT_BYTES,
      schema: { params: wsIdParamsSchema, body: importBodySchema },
      config: rateLimitEnabled ? { rateLimit: { max: 20, timeWindow: '1 hour' } } : undefined,
      onRequest: async (req, reply) => {
        // Reject oversized Content-Length and nonexistent workspaces before buffering 7 MB body
        const rawContentLength = req.headers['content-length'];
        if (typeof rawContentLength === 'string') {
          const contentLength = Number(rawContentLength);
          if (Number.isFinite(contentLength) && contentLength > IMPORT_BODY_LIMIT_BYTES) {
            return reply
              .code(413)
              .send(formatApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds 6 MB limit'));
          }
        }

        const wsId = (req.params as { wsId?: string } | undefined)?.wsId;
        if (!wsId || !/^[a-z2-7]{8,64}$/.test(wsId)) {
          return reply
            .code(400)
            .send(formatApiError('VALIDATION_ERROR', 'Invalid workspace identifier'));
        }
        // Throws 404 WORKSPACE_NOT_FOUND / WORKSPACE_EXPIRED before reading request body
        workspaceManager.getWorkspace(wsId);

        const clientKey = ipHasher.key(req.ip || 'unknown');
        const perClient = activeImportsByKey.get(clientKey) ?? 0;
        if (perClient >= MAX_CONCURRENT_IMPORTS_PER_IP) {
          void reply.header('Retry-After', '5');
          return reply
            .code(429)
            .send(
              formatApiError(
                'IMPORT_CONCURRENCY_LIMIT',
                'Another import is already in progress for this client. Wait for it to finish.',
              ),
            );
        }
        if (activeImportsGlobal >= MAX_CONCURRENT_IMPORTS_GLOBAL) {
          void reply.header('Retry-After', '5');
          return reply
            .code(503)
            .send(
              formatApiError(
                'IMPORT_BUSY',
                'Server is busy processing other imports. Please retry in a few seconds.',
              ),
            );
        }

        activeImportsGlobal += 1;
        activeImportsByKey.set(clientKey, perClient + 1);
        importSlotReleases.set(req, () => {
          activeImportsGlobal = Math.max(0, activeImportsGlobal - 1);
          const cur = activeImportsByKey.get(clientKey) ?? 1;
          if (cur <= 1) {
            activeImportsByKey.delete(clientKey);
          } else {
            activeImportsByKey.set(clientKey, cur - 1);
          }
        });
      },
      preHandler: async (req, reply) => {
        const bytes = Buffer.byteLength(req.body.sql, 'utf8');
        if (req.body.sql.length > IMPORT_SQL_MAX_BYTES || bytes > IMPORT_SQL_MAX_BYTES) {
          throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Imported SQL exceeds 6 MB limit');
        }
        if (!rateLimitEnabled) {
          return;
        }
        if (loadtestAllowIps.has(unwrapMappedIpv4(req.ip || ''))) {
          return;
        }
        const decision = importByteBudget.consume(ipHasher.key(req.ip || 'unknown'), bytes);
        if (!decision.allowed) {
          void reply.header('Retry-After', String(decision.retryAfterSec));
          const budgetMb = Math.round(config.IMPORT_BYTE_BUDGET_PER_HOUR / (1024 * 1024));
          return reply
            .code(429)
            .send(
              formatApiError(
                'IMPORT_BYTE_BUDGET_EXCEEDED',
                `Import byte budget (${budgetMb} MB/hour) exceeded. Retry in ${decision.retryAfterSec} seconds.`,
              ),
            );
        }
      },
    },
    async (req): Promise<ImportResponse> => {
      const importReq: ImportRequest = {
        sql: req.body.sql,
        mode: req.body.mode ?? 'fresh',
      };
      req.log.info(
        {
          wsId: req.params.wsId,
          mode: importReq.mode,
          ...sqlLogMeta(importReq.sql),
        },
        'Importing SQL file',
      );
      return importEngine.importSql(req.params.wsId, importReq);
    },
  );

  app.get<{ Params: { wsId: string } }>(
    '/api/workspaces/:wsId/schema',
    {
      schema: { params: wsIdParamsSchema },
      config: rateLimitEnabled ? { rateLimit: { max: 120, timeWindow: '1 minute' } } : undefined,
    },
    async (req): Promise<SchemaTree> => {
      const ws = workspaceManager.getWorkspace(req.params.wsId);
      workspaceManager.touchWorkspace(ws);
      return introspectWorkspaceSchema(adminPool, ws.database);
    },
  );

  app.post<{ Params: { wsId: string; session: SessionId } }>(
    '/api/workspaces/:wsId/sessions/:session/kill',
    {
      schema: { params: killParamsSchema },
      config: rateLimitEnabled ? { rateLimit: { max: 60, timeWindow: '1 minute' } } : undefined,
    },
    async (req): Promise<OkResponse> => {
      await workspaceManager.killSessionQuery(req.params.wsId, req.params.session);
      return { ok: true };
    },
  );

  app.post<{ Params: { wsId: string } }>(
    '/api/workspaces/:wsId/close',
    {
      schema: { params: wsIdParamsSchema },
      config: rateLimitEnabled ? { rateLimit: { max: 60, timeWindow: '1 minute' } } : undefined,
    },
    async (req): Promise<OkResponse> => {
      const callerIpHash = ipHasher.key(req.ip || 'unknown');
      await workspaceManager.deleteWorkspace(req.params.wsId, undefined, callerIpHash);
      return { ok: true };
    },
  );

  app.delete<{ Params: { wsId: string } }>(
    '/api/workspaces/:wsId',
    {
      schema: { params: wsIdParamsSchema },
      config: rateLimitEnabled ? { rateLimit: { max: 60, timeWindow: '1 minute' } } : undefined,
    },
    async (req): Promise<OkResponse> => {
      await workspaceManager.deleteWorkspace(req.params.wsId);
      return { ok: true };
    },
  );

  app.addHook('onClose', async () => {
    await workspaceManager.closeAllWorkspaces(false);
    if (ownsPool) {
      await adminPool.end();
    }
  });

  return { app, adminPool, datasets, workspaceManager, execEngine, importEngine, ipHasher };
}
