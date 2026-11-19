import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecResponse, ImportResponse } from '@sql-scratchpad/shared';
import { IpHasher, buildApp, loadConfig, type AppContext } from './index.js';
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

  it('enforces per-IP 6 live workspace limit (429 + Retry-After + hint), spoofed XFF resistance, and schema 120/min limit', async () => {
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
      // Create 6 workspaces from same IP (even while spoofing different X-Forwarded-For values)
      for (let i = 0; i < 6; i += 1) {
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

      // 7th create from same IP (with spoofed X-Forwarded-For) -> 429 with friendly message + Retry-After
      const seventh = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '198.51.100.50',
        headers: { 'x-forwarded-for': '203.0.113.250' },
        payload: { dataset: 'empty' },
      });
      expect(seventh.statusCode).toBe(429);
      expect(Number(seventh.headers['retry-after'])).toBeGreaterThan(0);
      const seventhBody = JSON.parse(seventh.body) as { error: { code: string; message: string } };
      expect(seventhBody.error.code).toBe('PER_IP_WORKSPACE_LIMIT');
      expect(seventhBody.error.message.toLowerCase()).toContain(
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

  it('F1: shares 6-workspace cap within same IPv6 /64 and between plain IPv4 and IPv4-mapped IPv6, but isolates different /64s', async () => {
    const rlCfg = loadConfig({
      ...process.env,
      LOG_LEVEL: 'silent',
      TRUST_PROXY: '10.0.0.1',
    });
    const rlCtx = await buildApp({
      config: rlCfg,
      adminPool: ctx.adminPool,
      enableRateLimit: true,
    });
    const localWsIds: string[] = [];

    try {
      for (const addr of [
        '2001:db8:abcd:1234::1',
        '2001:db8:abcd:1234::2',
        '2001:db8:abcd:1234::3',
        '2001:db8:abcd:1234::4',
        '2001:db8:abcd:1234::5',
        '2001:db8:abcd:1234::6',
      ]) {
        const res = await rlCtx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': addr },
          payload: { dataset: 'empty' },
        });
        expect(res.statusCode).toBe(201);
        localWsIds.push((JSON.parse(res.body) as { wsId: string }).wsId);
      }

      // 7th create from another host in the SAME /64 must hit 429 PER_IP_WORKSPACE_LIMIT
      const same64Blocked = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '2001:db8:abcd:1234::ffff' },
        payload: { dataset: 'empty' },
      });
      expect(same64Blocked.statusCode).toBe(429);
      expect(Number(same64Blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.parse(same64Blocked.body)).toMatchObject({
        error: { code: 'PER_IP_WORKSPACE_LIMIT' },
      });

      // Different /64 must succeed
      const diff64Ok = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '2001:db8:abcd:5678::1' },
        payload: { dataset: 'empty' },
      });
      expect(diff64Ok.statusCode).toBe(201);
      localWsIds.push((JSON.parse(diff64Ok.body) as { wsId: string }).wsId);

      // Plain IPv4 + IPv4-mapped IPv6 share one 6-workspace cap
      for (const addr of [
        '203.0.113.88',
        '::ffff:203.0.113.88',
        '203.0.113.88',
        '::ffff:203.0.113.88',
        '203.0.113.88',
        '::ffff:203.0.113.88',
      ]) {
        const res = await rlCtx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': addr },
          payload: { dataset: 'empty' },
        });
        expect(res.statusCode).toBe(201);
        localWsIds.push((JSON.parse(res.body) as { wsId: string }).wsId);
      }

      const mappedBlocked = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '::ffff:203.0.113.88' },
        payload: { dataset: 'empty' },
      });
      expect(mappedBlocked.statusCode).toBe(429);
      expect(Number(mappedBlocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.parse(mappedBlocked.body)).toMatchObject({
        error: { code: 'PER_IP_WORKSPACE_LIMIT' },
      });
    } finally {
      for (const id of localWsIds) {
        await rlCtx.app.inject({ method: 'DELETE', url: `/api/workspaces/${id}` });
      }
      await rlCtx.app.close();
    }
  });

  it('F2: rate-limits /reset (10/h), /kill (60/min), and DELETE (60/min) with Retry-After on 429', async () => {
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
    let wsId = '';

    try {
      const created = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '198.51.100.60',
        payload: { dataset: 'empty' },
      });
      expect(created.statusCode).toBe(201);
      wsId = (JSON.parse(created.body) as { wsId: string }).wsId;

      // /reset: 10 allowed per hour, 11th -> 429 + Retry-After
      for (let i = 0; i < 10; i += 1) {
        const res = await rlCtx.app.inject({
          method: 'POST',
          url: `/api/workspaces/${wsId}/reset`,
          remoteAddress: '198.51.100.60',
          payload: { dataset: 'empty' },
        });
        expect(res.statusCode, `reset #${i + 1}`).toBe(200);
      }
      const reset11 = await rlCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${wsId}/reset`,
        remoteAddress: '198.51.100.60',
        payload: { dataset: 'empty' },
      });
      expect(reset11.statusCode).toBe(429);
      expect(Number(reset11.headers['retry-after'])).toBeGreaterThan(0);

      // /kill: 60 allowed per minute, 61st -> 429 + Retry-After
      for (let i = 0; i < 60; i += 1) {
        const res = await rlCtx.app.inject({
          method: 'POST',
          url: `/api/workspaces/${wsId}/sessions/A/kill`,
          remoteAddress: '198.51.100.61',
        });
        expect(res.statusCode).toBe(200);
      }
      const kill61 = await rlCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${wsId}/sessions/A/kill`,
        remoteAddress: '198.51.100.61',
      });
      expect(kill61.statusCode).toBe(429);
      expect(Number(kill61.headers['retry-after'])).toBeGreaterThan(0);

      // DELETE: 60 allowed per minute, 61st -> 429 + Retry-After
      for (let i = 0; i < 60; i += 1) {
        const res = await rlCtx.app.inject({
          method: 'DELETE',
          url: '/api/workspaces/aaaaaaaaaaaaaaaaaaaaaaaaaa',
          remoteAddress: '198.51.100.62',
        });
        expect(res.statusCode).toBe(404);
      }
      const del61 = await rlCtx.app.inject({
        method: 'DELETE',
        url: '/api/workspaces/aaaaaaaaaaaaaaaaaaaaaaaaaa',
        remoteAddress: '198.51.100.62',
      });
      expect(del61.statusCode).toBe(429);
      expect(Number(del61.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      if (wsId) {
        await rlCtx.app.inject({
          method: 'DELETE',
          url: `/api/workspaces/${wsId}`,
          remoteAddress: '198.51.100.69',
        });
      }
      await rlCtx.app.close();
    }
  });

  it('F3: rotating the daily log salt does not reset the 6-workspace per-IP cap', async () => {
    const day1 = new Date('2026-11-19T23:59:00Z');
    const day2 = new Date('2026-11-20T00:01:00Z');
    const ipHasher = new IpHasher(day1);
    const rlCfg = loadConfig({
      ...process.env,
      LOG_LEVEL: 'silent',
      TRUST_PROXY: '',
    });
    const rlCtx = await buildApp({
      config: rlCfg,
      adminPool: ctx.adminPool,
      enableRateLimit: true,
      ipHasher,
    });
    const localWsIds: string[] = [];

    try {
      const logHashBefore = ipHasher.hash('198.51.100.70', day1);

      for (let i = 0; i < 6; i += 1) {
        const res = await rlCtx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '198.51.100.70',
          payload: { dataset: 'empty' },
        });
        expect(res.statusCode).toBe(201);
        localWsIds.push((JSON.parse(res.body) as { wsId: string }).wsId);
      }

      // Simulate UTC midnight log-salt rotation
      const logHashAfter = ipHasher.hash('198.51.100.70', day2);
      expect(logHashAfter).not.toBe(logHashBefore);

      // 7th create from the SAME IP must still hit the 6-workspace cap
      const seventhAfterRotation = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '198.51.100.70',
        payload: { dataset: 'empty' },
      });
      expect(seventhAfterRotation.statusCode).toBe(429);
      expect(Number(seventhAfterRotation.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.parse(seventhAfterRotation.body)).toMatchObject({
        error: { code: 'PER_IP_WORKSPACE_LIMIT' },
      });
    } finally {
      for (const id of localWsIds) {
        await rlCtx.app.inject({
          method: 'DELETE',
          url: `/api/workspaces/${id}`,
          remoteAddress: '198.51.100.71',
        });
      }
      await rlCtx.app.close();
    }
  });

  it('F4: reset during SLEEP(4) on A & B kills queries cleanly, delete during import aborts cleanly, janitor skips busy sessions, and error paths leak no locks', async () => {
    // Part A: reset during SLEEP(4) on BOTH session A and session B
    const wsReset = await createWs('sample-library', '203.0.113.42');
    const sleepA = execRaw(wsReset.wsId, 'SELECT SLEEP(4);', 'A');
    const sleepB = execRaw(wsReset.wsId, 'SELECT SLEEP(4);', 'B');

    await new Promise((r) => setTimeout(r, 300));

    const resetStart = Date.now();
    const resetRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsReset.wsId}/reset`,
      remoteAddress: CLIENT_IP,
      payload: { dataset: 'empty' },
    });
    const resetElapsed = Date.now() - resetStart;

    const [resA, resB] = await Promise.all([sleepA, sleepB]);
    expect(resetRes.statusCode).toBe(200);
    expect(resetElapsed).toBeLessThan(3500);

    // Both SLEEP(4) calls must be interrupted via KILL QUERY (errno 1317), not torn down mid-query with PROTOCOL_CONNECTION_LOST
    for (const r of [resA, resB]) {
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body) as ExecResponse;
      expect(body.results[0]?.kind).toBe('error');
      expect(body.results[0]?.error?.errno).toBe(1317);
    }

    // Locks must be cleanly released and both sessions usable after reset
    const entryAfterReset = ctx.workspaceManager.getWorkspace(wsReset.wsId);
    expect(entryAfterReset.sessionLocks.A).toBeFalsy();
    expect(entryAfterReset.sessionLocks.B).toBeFalsy();
    const postA = await execRaw(wsReset.wsId, 'SELECT 1;', 'A');
    const postB = await execRaw(wsReset.wsId, 'SELECT 2;', 'B');
    expect((JSON.parse(postA.body) as ExecResponse).results[0]?.rows).toEqual([[1]]);
    expect((JSON.parse(postB.body) as ExecResponse).results[0]?.rows).toEqual([[2]]);

    // Part B: delete during an active import
    const wsDel = await createWs('empty', '203.0.113.43');
    const importLines = [
      'CREATE TABLE del_race (id INT PRIMARY KEY);',
      'SELECT SLEEP(4);',
    ];
    for (let i = 1; i <= 200; i += 1) {
      importLines.push(`INSERT INTO del_race VALUES (${i});`);
    }
    const importPromise = ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsDel.wsId}/import`,
      remoteAddress: CLIENT_IP,
      payload: { sql: importLines.join('\n'), mode: 'append' },
    });

    await new Promise((r) => setTimeout(r, 300));

    const delStart = Date.now();
    const delRes = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${wsDel.wsId}`,
      remoteAddress: CLIENT_IP,
    });
    const delElapsed = Date.now() - delStart;
    createdWsIds.delete(wsDel.wsId);

    const impDone = await importPromise;
    expect(delRes.statusCode).toBe(200);
    expect(delElapsed).toBeLessThan(3500);
    expect(impDone.statusCode).toBe(200);
    const impBody = JSON.parse(impDone.body) as ImportResponse;
    expect(impBody.ok).toBe(false);
    expect(
      impBody.error?.errno === 1317 || impBody.error?.code === 'QUERY_INTERRUPTED',
      `expected clean interrupt, got ${JSON.stringify(impBody.error)}`,
    ).toBe(true);

    const [leftoverDb] = await ctx.adminPool.query<RowDataPacket[]>(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [wsDel.database],
    );
    expect(leftoverDb).toEqual([]);

    // Part C: janitor skips busy sessions (expiry + idle-session + size-cap truncation)
    const janCfg = loadConfig({
      ...process.env,
      LOG_LEVEL: 'silent',
      WORKSPACE_TTL_MS: '60000',
      WORKSPACE_MAX_TTL_MS: '120000',
      SESSION_IDLE_TTL_MS: '50',
      MAX_WORKSPACE_BYTES: '1',
    });
    const janCtx = await buildApp({
      config: janCfg,
      adminPool: ctx.adminPool,
      enableRateLimit: false,
    });
    let janWsId = '';
    try {
      const c = await janCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '198.51.100.80',
        payload: { dataset: 'sample-library' },
      });
      expect(c.statusCode).toBe(201);
      janWsId = (JSON.parse(c.body) as { wsId: string }).wsId;

      const busySleep = janCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${janWsId}/exec`,
        payload: { sql: 'SELECT SLEEP(4);', session: 'A', stopOnError: true },
      });
      await new Promise((r) => setTimeout(r, 300));

      const janEntry = janCtx.workspaceManager.getWorkspace(janWsId);
      janEntry.expiresAt = Date.now() - 1;
      if (janEntry.sessions.A) {
        janEntry.sessions.A.lastUsedAt = Date.now() - 10_000;
      }

      const sweep = await janCtx.workspaceManager.runJanitorSweep();
      expect(sweep.expiredWorkspaces).toBe(0);
      expect(sweep.closedIdleSessions).toBe(0);
      expect(sweep.truncatedWorkspaces).toBe(0);

      // Restore expiry before invoking /kill so the workspace is live, then kill the sleep
      janEntry.expiresAt = Date.now() + 60_000;
      const killJanRes = await janCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${janWsId}/sessions/A/kill`,
      });
      expect(killJanRes.statusCode).toBe(200);
      const busyDone = await busySleep;
      expect(busyDone.statusCode).toBe(200);
      expect((JSON.parse(busyDone.body) as ExecResponse).results[0]?.error?.errno).toBe(1317);

      // Part D: no lock leaks on error paths (unknown dataset reset AND teardown timeout)
      const badReset = await janCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${janWsId}/reset`,
        payload: { dataset: 'nonexistent-dataset' },
      });
      expect(badReset.statusCode).toBe(400);
      expect(janEntry.sessionLocks.A).toBeFalsy();
      expect(janEntry.sessionLocks.B).toBeFalsy();

      // Simulate a stuck session A lock -> reset acquires B then times out on A and MUST release B + flags
      janEntry.sessionLocks.A = true;
      await expect(
        janCtx.workspaceManager.resetWorkspace(janWsId, 'empty', 120),
      ).rejects.toMatchObject({ statusCode: 503, code: 'SESSION_TEARDOWN_TIMEOUT' });
      expect(janEntry.sessionLocks.B).toBeFalsy();
      expect(janEntry.teardownActive).toBe(false);
      expect(janEntry.sessionAbort.A).toBeFalsy();
      expect(janEntry.sessionAbort.B).toBeFalsy();
      janEntry.sessionLocks.A = false;

      const afterTimeoutA = await janCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${janWsId}/exec`,
        payload: { sql: 'SELECT 42;', session: 'A', stopOnError: true },
      });
      const afterTimeoutB = await janCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${janWsId}/exec`,
        payload: { sql: 'SELECT 43;', session: 'B', stopOnError: true },
      });
      expect((JSON.parse(afterTimeoutA.body) as ExecResponse).results[0]?.rows).toEqual([[42]]);
      expect((JSON.parse(afterTimeoutB.body) as ExecResponse).results[0]?.rows).toEqual([[43]]);
    } finally {
      if (janWsId) {
        await janCtx.app.inject({ method: 'DELETE', url: `/api/workspaces/${janWsId}` });
      }
      await janCtx.app.close();
    }
  });

  it('POST /api/workspaces/:wsId/close enforces IP-key ownership, accepts beacon-style empty/text POST, frees cap slots, and rate-limits at 60/min', async () => {
    const rlCfg = loadConfig({
      ...process.env,
      LOG_LEVEL: 'silent',
      TRUST_PROXY: '10.0.0.1',
    });
    const rlCtx = await buildApp({
      config: rlCfg,
      adminPool: ctx.adminPool,
      enableRateLimit: true,
    });
    const localWsIds: string[] = [];

    try {
      // Fill all 6 slots for owner IP 198.51.100.90
      for (let i = 0; i < 6; i += 1) {
        const res = await rlCtx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': '198.51.100.90' },
          payload: { dataset: 'empty' },
        });
        expect(res.statusCode).toBe(201);
        localWsIds.push((JSON.parse(res.body) as { wsId: string }).wsId);
      }

      const targetWsId = localWsIds[0]!;
      const secondWsId = localWsIds[1]!;

      // Non-owner IP MUST be rejected with 403 and workspace must stay alive
      const nonOwnerClose = await rlCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${targetWsId}/close`,
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.99' },
      });
      expect(nonOwnerClose.statusCode).toBe(403);
      expect(JSON.parse(nonOwnerClose.body)).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
      expect(rlCtx.workspaceManager.getWorkspace(targetWsId).wsId).toBe(targetWsId);

      // Owner IP closing with beacon-style empty POST succeeds (200) and frees a slot
      const ownerClose = await rlCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${targetWsId}/close`,
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.90' },
      });
      expect(ownerClose.statusCode).toBe(200);
      expect(JSON.parse(ownerClose.body)).toEqual({ ok: true });
      localWsIds.shift();

      // IPv4-mapped IPv6 of same owner IP with text/plain body also succeeds
      const mappedOwnerClose = await rlCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${secondWsId}/close`,
        remoteAddress: '10.0.0.1',
        headers: {
          'x-forwarded-for': '::ffff:198.51.100.90',
          'content-type': 'text/plain;charset=UTF-8',
        },
        payload: '',
      });
      expect(mappedOwnerClose.statusCode).toBe(200);
      expect(JSON.parse(mappedOwnerClose.body)).toEqual({ ok: true });
      localWsIds.shift();

      // Freed slot allows creating a replacement workspace
      const replacement = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.90' },
        payload: { dataset: 'empty' },
      });
      expect(replacement.statusCode).toBe(201);
      localWsIds.push((JSON.parse(replacement.body) as { wsId: string }).wsId);

      // Rate-limited at 60/min like DELETE
      for (let i = 0; i < 60; i += 1) {
        const res = await rlCtx.app.inject({
          method: 'POST',
          url: '/api/workspaces/aaaaaaaaaaaaaaaaaaaaaaaaaa/close',
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': '198.51.100.95' },
        });
        expect(res.statusCode).toBe(404);
      }
      const close61 = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces/aaaaaaaaaaaaaaaaaaaaaaaaaa/close',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.95' },
      });
      expect(close61.statusCode).toBe(429);
      expect(Number(close61.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      for (const id of localWsIds) {
        await rlCtx.app.inject({
          method: 'DELETE',
          url: `/api/workspaces/${id}`,
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': '198.51.100.98' },
        });
      }
      await rlCtx.app.close();
    }
  });
});
