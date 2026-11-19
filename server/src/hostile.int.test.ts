import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecResponse, ImportResponse } from '@sql-scratchpad/shared';
import { buildApp, loadConfig, type AppContext } from './index.js';
import {
  BENCHMARK_BOMB_SQL,
  DELIMITER_ABUSE_SQL,
  FILE_IO_CASES,
  LOG_CANARY_TOKEN,
  PRIVILEGE_ESCALATION_CASES,
  RECURSIVE_CTE_BOMB_SQL,
  build5MbStringLiteralSql,
  build60001StatementsSql,
  buildBulkRowsImportSql,
  buildDeeplyNestedCommentsSql,
} from './fixtures/hostile-corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '..', '.env'), quiet: true });

describe('SQL Scratchpad M8-lite hostile corpus & hardening integration (real MariaDB 11.4)', () => {
  let ctx: AppContext;
  const createdWsIds = new Set<string>();
  const capturedLogs: string[] = [];
  const CLIENT_IP = '203.0.113.42';

  async function createWs(
    dataset: string,
    remoteAddress = CLIENT_IP,
  ): Promise<{ wsId: string; database: string; expiresAt: string }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      remoteAddress,
      payload: { dataset },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { wsId: string; database: string; expiresAt: string };
    createdWsIds.add(body.wsId);
    return body;
  }

  async function execRaw(
    wsId: string,
    sql: string,
    session: 'A' | 'B' = 'A',
    remoteAddress = CLIENT_IP,
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/exec`,
      remoteAddress,
      payload: { sql, session, stopOnError: true },
    });
  }

  async function assertCanaryHealthy(healthyWsId: string): Promise<void> {
    const h = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: CLIENT_IP,
    });
    expect(h.statusCode).toBe(200);
    expect(JSON.parse(h.body)).toMatchObject({ status: 'ok', db: 'ok' });

    const r = await execRaw(healthyWsId, 'SELECT 1 AS alive;', 'A', '203.0.113.99');
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as ExecResponse;
    expect(body.results[0]?.kind).toBe('rows');
    expect(body.results[0]?.rows).toEqual([[1]]);
  }

  beforeAll(async () => {
    const logStream = new PassThrough();
    logStream.on('data', (chunk: Buffer) => {
      capturedLogs.push(chunk.toString('utf8'));
    });

    const config = loadConfig({
      ...process.env,
      LOG_LEVEL: 'info',
      TRUST_PROXY: '',
    });
    ctx = await buildApp({
      config,
      enableRateLimit: false,
      logStream,
    });
  });

  afterEach(async () => {
    for (const wsId of [...createdWsIds]) {
      createdWsIds.delete(wsId);
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/workspaces/${wsId}`,
        remoteAddress: CLIENT_IP,
      });
    }
  });

  afterAll(async () => {
    const [schemas] = await ctx.adminPool.query<RowDataPacket[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'ws\\_%'",
    );
    const [users] = await ctx.adminPool.query<RowDataPacket[]>(
      "SELECT User FROM mysql.user WHERE User LIKE 'ws\\_%'",
    );
    await ctx.app.close();

    const fullLog = capturedLogs.join('');
    if (process.env.HOSTILE_LOG_DUMP_PATH) {
      writeFileSync(process.env.HOSTILE_LOG_DUMP_PATH, fullLog, 'utf8');
    }

    // Block 8.4: Assert zero SQL keywords/canaries and zero raw IPv4 addresses in app logs
    expect(fullLog.length).toBeGreaterThan(0);
    expect(fullLog).not.toContain(LOG_CANARY_TOKEN);
    expect(fullLog).not.toContain('INTO OUTFILE');
    expect(fullLog).not.toContain('BENCHMARK(');
    expect(fullLog).not.toContain('mysql.user');
    expect(fullLog).not.toContain(CLIENT_IP);
    expect(fullLog).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);

    expect(schemas).toEqual([]);
    expect(users).toEqual([]);
  });

  it('verifies DB max_connections=150, global workspace 503 message, and idle/absolute TTLs + idle session rollback', async () => {
    const [rows] = await ctx.adminPool.query<RowDataPacket[]>(
      "SHOW VARIABLES LIKE 'max_connections'",
    );
    expect(Number(rows[0]?.Value)).toBe(150);

    // Test global workspace cap 503 message on a tiny-cap app instance
    const tinyCfg = loadConfig({
      ...process.env,
      LOG_LEVEL: 'silent',
      MAX_WORKSPACES: '1',
      MAX_WORKSPACES_PER_IP: '5',
      WORKSPACE_TTL_MS: '60000',
      WORKSPACE_MAX_TTL_MS: '120000',
      SESSION_IDLE_TTL_MS: '50',
    });
    const tinyCtx = await buildApp({
      config: tinyCfg,
      adminPool: ctx.adminPool,
      enableRateLimit: false,
    });

    try {
      const r1 = await tinyCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '198.51.100.1',
        payload: { dataset: 'empty' },
      });
      expect(r1.statusCode).toBe(201);
      const ws1 = JSON.parse(r1.body) as { wsId: string };

      const r2 = await tinyCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '198.51.100.2',
        payload: { dataset: 'empty' },
      });
      expect(r2.statusCode).toBe(503);
      expect(JSON.parse(r2.body)).toEqual({
        error: {
          code: 'WORKSPACE_LIMIT_REACHED',
          message: 'SQL Scratchpad is busy, try again in a few minutes',
        },
      });

      // Open a transaction, wait > SESSION_IDLE_TTL_MS, run janitor sweep -> rolled back & session closed
      await tinyCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws1.wsId}/exec`,
        payload: {
          sql: 'CREATE TABLE tx_test (id INT PRIMARY KEY); START TRANSACTION; INSERT INTO tx_test VALUES (1);',
          session: 'A',
          stopOnError: true,
        },
      });
      await new Promise((r) => setTimeout(r, 80));
      const sweep1 = await tinyCtx.workspaceManager.runJanitorSweep();
      expect(sweep1.closedIdleSessions).toBe(1);

      // Re-querying sees 0 rows (open transaction was rolled back)
      const checkTx = await tinyCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws1.wsId}/exec`,
        payload: { sql: 'SELECT COUNT(*) FROM tx_test;', session: 'A', stopOnError: true },
      });
      const txBody = JSON.parse(checkTx.body) as ExecResponse;
      expect(txBody.results[0]?.rows).toEqual([[0]]);

      // Force absolute TTL expiry and verify touchWorkspace cannot extend past absoluteExpiresAt
      const entry = tinyCtx.workspaceManager.getWorkspace(ws1.wsId);
      entry.absoluteExpiresAt = Date.now() - 1;
      tinyCtx.workspaceManager.touchWorkspace(entry);
      expect(entry.expiresAt).toBeLessThanOrEqual(entry.absoluteExpiresAt);
      const sweep2 = await tinyCtx.workspaceManager.runJanitorSweep();
      expect(sweep2.expiredWorkspaces).toBe(1);
    } finally {
      await tinyCtx.app.close();
    }
  });

  it('enforces per-IP 3 live workspace limit (429 + Retry-After + hint), spoofed XFF resistance, and schema 120/min limit', async () => {
    const rlCfg = loadConfig({
      ...process.env,
      LOG_LEVEL: 'silent',
      TRUST_PROXY: '',
    });
    const rlCtx = await buildApp({
      config: rlCfg,
      adminPool: ctx.adminPool,
      enableRateLimit: true,
    });
    const localWsIds: string[] = [];

    try {
      // Create 3 workspaces from same IP (even while spoofing different X-Forwarded-For values)
      for (let i = 0; i < 3; i += 1) {
        const res = await rlCtx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '198.51.100.50',
          headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
          payload: { dataset: 'empty' },
        });
        expect(res.statusCode).toBe(201);
        localWsIds.push((JSON.parse(res.body) as { wsId: string }).wsId);
      }

      // 4th create from same IP (with spoofed X-Forwarded-For) -> 429 with friendly message + Retry-After
      const fourth = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '198.51.100.50',
        headers: { 'x-forwarded-for': '203.0.113.250' },
        payload: { dataset: 'empty' },
      });
      expect(fourth.statusCode).toBe(429);
      expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);
      const fourthBody = JSON.parse(fourth.body) as { error: { code: string; message: string } };
      expect(fourthBody.error.code).toBe('PER_IP_WORKSPACE_LIMIT');
      expect(fourthBody.error.message.toLowerCase()).toContain(
        'close a workspace or wait for it to expire',
      );

      // Verify ownership stored only as hash, never raw IP
      const wsEntry = rlCtx.workspaceManager.getWorkspace(localWsIds[0]!);
      expect(wsEntry.ownerIpHash).toMatch(/^[0-9a-f]{16}$/);
      expect(wsEntry.ownerIpHash).not.toContain('198.51.100.50');

      // Deleting one workspace frees a slot
      const del = await rlCtx.app.inject({
        method: 'DELETE',
        url: `/api/workspaces/${localWsIds.pop()!}`,
        remoteAddress: '198.51.100.50',
      });
      expect(del.statusCode).toBe(200);

      const replacement = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '198.51.100.50',
        payload: { dataset: 'empty' },
      });
      expect(replacement.statusCode).toBe(201);
      localWsIds.push((JSON.parse(replacement.body) as { wsId: string }).wsId);

      // Verify schema 120/min rate limit returns 429 + Retry-After on 121st call
      const targetWs = localWsIds[0]!;
      for (let i = 0; i < 120; i += 1) {
        const s = await rlCtx.app.inject({
          method: 'GET',
          url: `/api/workspaces/${targetWs}/schema`,
          remoteAddress: '198.51.100.51',
        });
        expect(s.statusCode).toBe(200);
      }
      const overSchema = await rlCtx.app.inject({
        method: 'GET',
        url: `/api/workspaces/${targetWs}/schema`,
        remoteAddress: '198.51.100.51',
      });
      expect(overSchema.statusCode).toBe(429);
      expect(Number(overSchema.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      for (const id of localWsIds) {
        await rlCtx.app.inject({ method: 'DELETE', url: `/api/workspaces/${id}` });
      }
      await rlCtx.app.close();
    }
  });

  it('blocks privilege escalation and file I/O both at API pre-flight and directly in MariaDB', async () => {
    const attacker = await createWs('sample-library', '203.0.113.42');
    const bystander = await createWs('empty', '203.0.113.99');

    // 1. API pre-flight denies every privilege escalation and file I/O statement
    for (const tc of [...PRIVILEGE_ESCALATION_CASES, ...FILE_IO_CASES]) {
      const res = await execRaw(attacker.wsId, tc.sql);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as ExecResponse;
      expect(body.results[0]?.kind, `API should deny ${tc.label}`).toBe('error');
      expect(body.results[0]?.error?.code).toBe('PLAYGROUND_DENIED');
    }

    // 2. Direct MariaDB connection as workspace user (bypassing API denylist) is ALSO denied by MariaDB privileges
    const entry = ctx.workspaceManager.getWorkspace(attacker.wsId);
    const directConn = await mysql.createConnection({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3307),
      user: entry.dbUser,
      password: entry.password,
      database: entry.database,
    });
    try {
      for (const tc of [...PRIVILEGE_ESCALATION_CASES, ...FILE_IO_CASES]) {
        await expect(
          directConn.query(tc.sql),
          `MariaDB must directly reject ${tc.label}`,
        ).rejects.toThrow();
      }
    } finally {
      await directConn.end();
    }

    await assertCanaryHealthy(bystander.wsId);
  });

  it('blocks mysql.user reads, information_schema cross-workspace probing, USE other schemas, and KILL of another thread', async () => {
    const wsA = await createWs('sample-library', '203.0.113.42');
    const wsB = await createWs('sample-library', '203.0.113.99');

    // 1. SELECT * FROM mysql.user -> denied by MariaDB (errno 1142)
    const mysqlUser = await execRaw(wsA.wsId, 'SELECT User, Host FROM mysql.user;');
    const mysqlUserBody = JSON.parse(mysqlUser.body) as ExecResponse;
    expect(mysqlUserBody.results[0]?.kind).toBe('error');
    expect(mysqlUserBody.results[0]?.error?.errno).toBe(1142);

    // 2. information_schema probing sees ONLY its own ws_* schema (never wsB or tpl_*)
    const schemataRes = await execRaw(
      wsA.wsId,
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'ws\\_%' OR SCHEMA_NAME LIKE 'tpl\\_%';",
    );
    const schemataBody = JSON.parse(schemataRes.body) as ExecResponse;
    expect(schemataBody.results[0]?.kind).toBe('rows');
    const visibleSchemas = (schemataBody.results[0]?.rows ?? []).map((r) => String(r[0]));
    expect(visibleSchemas).toEqual([wsA.database]);
    expect(visibleSchemas).not.toContain(wsB.database);
    expect(visibleSchemas).not.toContain('tpl_sample_library');

    const tablesRes = await execRaw(
      wsA.wsId,
      `SELECT TABLE_SCHEMA, TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA IN ('${wsB.database}', 'tpl_sample_library');`,
    );
    const tablesBody = JSON.parse(tablesRes.body) as ExecResponse;
    expect(tablesBody.results[0]?.rows).toEqual([]);

    // 3. USE another ws_* and USE tpl_* blocked by denylist AND directly by MariaDB (errno 1044)
    for (const targetDb of [wsB.database, 'tpl_sample_library']) {
      const apiUse = await execRaw(wsA.wsId, `USE \`${targetDb}\`;`);
      const apiUseBody = JSON.parse(apiUse.body) as ExecResponse;
      expect(apiUseBody.results[0]?.kind).toBe('error');
      expect(apiUseBody.results[0]?.error?.code).toBe('PLAYGROUND_DENIED');

      const entryA = ctx.workspaceManager.getWorkspace(wsA.wsId);
      const directConn = await mysql.createConnection({
        host: process.env.DB_HOST ?? '127.0.0.1',
        port: Number(process.env.DB_PORT ?? 3307),
        user: entryA.dbUser,
        password: entryA.password,
        database: entryA.database,
      });
      try {
        await expect(directConn.query(`USE \`${targetDb}\``)).rejects.toMatchObject({
          errno: 1044,
        });
      } finally {
        await directConn.end();
      }
    }

    // 4. KILL of another workspace's connection id -> denied by MariaDB (errno 1095)
    // Open wsB session A first so it has a live threadId
    await execRaw(wsB.wsId, 'SELECT 1;', 'A', '203.0.113.99');
    const wsBThreadId = ctx.workspaceManager.getWorkspace(wsB.wsId).sessions.A!.threadId;
    const killRes = await execRaw(wsA.wsId, `KILL ${wsBThreadId};`);
    const killBody = JSON.parse(killRes.body) as ExecResponse;
    expect(killBody.results[0]?.kind).toBe('error');
    expect(killBody.results[0]?.error?.errno).toBe(1095);

    const killQueryRes = await execRaw(wsA.wsId, `KILL QUERY ${wsBThreadId};`);
    const killQueryBody = JSON.parse(killQueryRes.body) as ExecResponse;
    expect(killQueryBody.results[0]?.kind).toBe('error');
    expect(killQueryBody.results[0]?.error?.errno).toBe(1095);

    await assertCanaryHealthy(wsB.wsId);
  });

  it('bounds CPU/time bombs: recursive CTE bomb, 20k-row cartesian join, BENCHMARK(), and 5 parallel SLEEP(30) storms', async () => {
    const attacker = await createWs('empty', '203.0.113.42');
    const bystander = await createWs('sample-library', '203.0.113.99');

    // 1. Recursive CTE bomb -> bounded by max_recursive_iterations = 1000
    const cteRes = await execRaw(attacker.wsId, RECURSIVE_CTE_BOMB_SQL);
    const cteBody = JSON.parse(cteRes.body) as ExecResponse;
    // MariaDB stops at max_recursive_iterations (1000) either with truncated result or error/warning
    const cteFirst = cteBody.results[0]!;
    if (cteFirst.kind === 'rows') {
      expect(Number(cteFirst.rows?.[0]?.[0])).toBeLessThanOrEqual(1001);
    } else {
      expect(cteFirst.kind).toBe('error');
    }
    expect(cteFirst.durationMs).toBeLessThan(3000);

    // 2. Import 20,000-row table and run cartesian join bomb -> bounded by MAX_STATEMENT_TIME=5
    const bulkSql = buildBulkRowsImportSql(20_000);
    const impRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${attacker.wsId}/import`,
      remoteAddress: CLIENT_IP,
      payload: { sql: bulkSql, mode: 'fresh' },
    });
    expect(impRes.statusCode).toBe(200);
    expect((JSON.parse(impRes.body) as ImportResponse).ok).toBe(true);

    const cartStart = Date.now();
    const cartRes = await execRaw(
      attacker.wsId,
      'SELECT COUNT(*) FROM big_items a CROSS JOIN big_items b CROSS JOIN big_items c;',
    );
    const cartElapsed = Date.now() - cartStart;
    const cartBody = JSON.parse(cartRes.body) as ExecResponse;
    expect(cartBody.results[0]?.kind).toBe('error');
    expect(cartBody.results[0]?.error?.errno).toBe(1969);
    expect(cartElapsed).toBeLessThan(9000);

    // 3. BENCHMARK() bomb -> blocked immediately by API pre-flight AND bounded at ~5 s directly by MariaDB
    const benchApiRes = await execRaw(attacker.wsId, BENCHMARK_BOMB_SQL);
    const benchApiBody = JSON.parse(benchApiRes.body) as ExecResponse;
    expect(benchApiBody.results[0]?.kind).toBe('error');
    expect(benchApiBody.results[0]?.error?.code).toBe('PLAYGROUND_DENIED');

    const entry = ctx.workspaceManager.getWorkspace(attacker.wsId);
    const directBenchConn = await mysql.createConnection({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3307),
      user: entry.dbUser,
      password: entry.password,
      database: entry.database,
    });
    try {
      const benchStart = Date.now();
      await directBenchConn.query(BENCHMARK_BOMB_SQL).catch(() => {});
      const benchElapsed = Date.now() - benchStart;
      // MariaDB MAX_STATEMENT_TIME = 5 interrupts the loop at ~5 s instead of running 1e9 SHA2 iterations
      expect(benchElapsed).toBeLessThan(9000);
    } finally {
      await directBenchConn.end();
    }

    // 4. SLEEP storm: 5 parallel SLEEP(30) across sessions A and B while bystander runs SELECT 1 concurrently
    const stormStart = Date.now();
    const stormPromises = [
      execRaw(attacker.wsId, 'SELECT SLEEP(30);', 'A'),
      execRaw(attacker.wsId, 'SELECT SLEEP(30);', 'A'),
      execRaw(attacker.wsId, 'SELECT SLEEP(30);', 'A'),
      execRaw(attacker.wsId, 'SELECT SLEEP(30);', 'B'),
      execRaw(attacker.wsId, 'SELECT SLEEP(30);', 'B'),
    ];

    // Give storm requests 300ms to enter MariaDB SLEEP, then run SELECT 1 on bystander
    await new Promise((r) => setTimeout(r, 300));
    const canaryStart = Date.now();
    await assertCanaryHealthy(bystander.wsId);
    const canaryMs = Date.now() - canaryStart;
    expect(canaryMs).toBeLessThan(2000);

    const stormResults = await Promise.all(stormPromises);
    const stormElapsed = Date.now() - stormStart;
    expect(stormElapsed).toBeLessThan(9500);

    const statusCodes = stormResults.map((r) => r.statusCode);
    // 3 concurrent duplicates rejected immediately with 409 SESSION_BUSY, 2 active sessions bounded at ~5 s
    expect(statusCodes.filter((c) => c === 409).length).toBe(3);
    expect(statusCodes.filter((c) => c === 200).length).toBe(2);
    for (const r of stormResults.filter((x) => x.statusCode === 200)) {
      const b = JSON.parse(r.body) as ExecResponse;
      const first = b.results[0]!;
      expect(first.kind === 'error' || first.rows?.[0]?.[0] === 1).toBe(true);
    }

    await assertCanaryHealthy(bystander.wsId);
  });

  it('bounds parser, size, and packet abuse: 6 MB+1 import, 60,001 statements, DELIMITER abuse, deeply nested comments, 5 MB string literal', async () => {
    const attacker = await createWs('empty', '203.0.113.42');
    const bystander = await createWs('empty', '203.0.113.99');

    // 1. 6 MB + 1 import -> 413 PAYLOAD_TOO_LARGE
    const over6Mb = 'a'.repeat(6 * 1024 * 1024 + 1);
    const overRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${attacker.wsId}/import`,
      remoteAddress: CLIENT_IP,
      payload: { sql: over6Mb, mode: 'fresh' },
    });
    expect(overRes.statusCode).toBe(413);

    // 2. 60,001 statements -> 400 TOO_MANY_STATEMENTS
    const tooManyRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${attacker.wsId}/import`,
      remoteAddress: CLIENT_IP,
      payload: { sql: build60001StatementsSql(), mode: 'fresh' },
    });
    expect(tooManyRes.statusCode).toBe(400);
    expect(JSON.parse(tooManyRes.body)).toMatchObject({
      error: { code: 'TOO_MANY_STATEMENTS' },
    });

    // 3. DELIMITER abuse trying to smuggle GRANT -> bounded & denied
    const delimRes = await execRaw(attacker.wsId, DELIMITER_ABUSE_SQL);
    expect(delimRes.statusCode).toBe(200);
    const delimBody = JSON.parse(delimRes.body) as ExecResponse;
    expect(delimBody.results.some((r) => r.kind === 'error')).toBe(true);

    // 4. Deeply nested / repeated comments + conditional comment GRANT smuggling -> fast & denied
    const tComment = Date.now();
    const commentRes = await execRaw(attacker.wsId, buildDeeplyNestedCommentsSql(2000));
    expect(Date.now() - tComment).toBeLessThan(3000);
    expect(commentRes.statusCode).toBe(200);
    const commentBody = JSON.parse(commentRes.body) as ExecResponse;
    expect(commentBody.results[0]?.kind).toBe('error');
    expect(commentBody.results[0]?.error?.code).toBe('PLAYGROUND_DENIED');

    // 5. 5 MB single-statement string literal:
    //    - via /exec -> 413 (exceeds 256 KB body limit)
    //    - via /import -> bounded by MariaDB max_allowed_packet = 4M, DB stays healthy
    const fiveMbSql = build5MbStringLiteralSql();
    const fiveMbExec = await execRaw(attacker.wsId, fiveMbSql);
    expect(fiveMbExec.statusCode).toBe(413);

    const fiveMbImport = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${attacker.wsId}/import`,
      remoteAddress: CLIENT_IP,
      payload: { sql: fiveMbSql, mode: 'fresh' },
    });
    expect(fiveMbImport.statusCode).toBe(200);
    const fiveMbImportBody = JSON.parse(fiveMbImport.body) as ImportResponse;
    expect(fiveMbImportBody.ok).toBe(false);
    expect(fiveMbImportBody.error).toBeDefined();

    await assertCanaryHealthy(bystander.wsId);
  });
});
