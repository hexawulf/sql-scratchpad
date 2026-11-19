import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ExecResponse, ImportResponse, SchemaTree } from '@sql-scratchpad/shared';
import { buildApp, loadConfig, type AppContext } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '..', '.env'), quiet: true });

describe('SQL Scratchpad API integration (real MariaDB 11.4)', () => {
  let ctx: AppContext;
  const createdWsIds = new Set<string>();

  async function createWs(dataset: string): Promise<{ wsId: string; database: string }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { dataset },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { wsId: string; database: string; expiresAt: string };
    createdWsIds.add(body.wsId);
    return body;
  }

  async function execSql(
    wsId: string,
    sql: string,
    session: 'A' | 'B' = 'A',
    stopOnError = true,
  ): Promise<ExecResponse> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/exec`,
      payload: { sql, session, stopOnError },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as ExecResponse;
  }

  async function importSql(
    wsId: string,
    sql: string,
    mode: 'fresh' | 'append' = 'fresh',
  ): Promise<{ statusCode: number; body: ImportResponse }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/import`,
      payload: { sql, mode },
    });
    return {
      statusCode: res.statusCode,
      body: JSON.parse(res.body) as ImportResponse,
    };
  }

  beforeAll(async () => {
    const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });
    ctx = await buildApp({ config, enableRateLimit: false });
  });

  afterEach(async () => {
    for (const wsId of [...createdWsIds]) {
      createdWsIds.delete(wsId);
      await ctx.app.inject({ method: 'DELETE', url: `/api/workspaces/${wsId}` });
    }
  });

  afterAll(async () => {
    // Assert zero orphaned ws_* databases or users left behind
    const [schemas] = await ctx.adminPool.query<RowDataPacket[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'ws\\_%'",
    );
    const [users] = await ctx.adminPool.query<RowDataPacket[]>(
      "SELECT User FROM mysql.user WHERE User LIKE 'ws\\_%'",
    );
    await ctx.app.close();
    expect(schemas).toEqual([]);
    expect(users).toEqual([]);
  });

  it('serves /api/health and /api/datasets with only sample-library and empty', async () => {
    const h = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(h.statusCode).toBe(200);
    expect(JSON.parse(h.body)).toMatchObject({ status: 'ok', db: 'ok' });

    const d = await ctx.app.inject({ method: 'GET', url: '/api/datasets' });
    expect(d.statusCode).toBe(200);
    const list = JSON.parse(d.body) as Array<{ id: string; engines: string[] }>;
    expect(list.map((x) => x.id)).toEqual(['sample-library', 'empty']);
    expect(list.find((x) => x.id === 'sample-library')?.engines).toEqual(['mariadb', 'sqlite']);
  });

  it('passes sample-library golden queries: SELECT/WHERE/GROUP BY/HAVING/ORDER BY, INNER/LEFT JOIN, UNION, CREATE VIEW', async () => {
    const { wsId } = await createWs('sample-library');

    // SELECT + WHERE + ORDER BY
    const expensive = await execSql(
      wsId,
      'SELECT book_id, title, price FROM Books WHERE price >= 35.00 ORDER BY price DESC;',
    );
    expect(expensive.results[0]?.rows).toEqual([
      [109, 'Distributed Systems Field Guide', '48.00'],
      [105, 'Practical Query Tuning', '44.00'],
      [101, 'Foundations of Relational Storage', '39.50'],
    ]);

    // GROUP BY + HAVING + ORDER BY
    const genres = await execSql(
      wsId,
      `SELECT genre, COUNT(*) AS book_count
       FROM Books
       GROUP BY genre
       HAVING COUNT(*) >= 3
       ORDER BY genre ASC;`,
    );
    expect(genres.results[0]?.rows?.map((r) => [r[0], Number(r[1])])).toEqual([
      ['Fiction', 3],
      ['Technology', 3],
    ]);

    // INNER JOIN across N:M BookAuthors (co-authored books)
    const coAuthored = await execSql(
      wsId,
      `SELECT b.book_id, b.title, COUNT(ba.author_id) AS author_count
       FROM Books b
       INNER JOIN BookAuthors ba ON b.book_id = ba.book_id
       GROUP BY b.book_id, b.title
       HAVING COUNT(ba.author_id) > 1
       ORDER BY b.book_id;`,
    );
    expect(coAuthored.results[0]?.rows?.map((r) => [r[0], r[1], Number(r[2])])).toEqual([
      [101, 'Foundations of Relational Storage', 2],
      [107, 'Quiet Orbits', 2],
    ]);

    // LEFT JOIN: books never loaned (110, 112) and author without books (10)
    const unloanedBooks = await execSql(
      wsId,
      `SELECT b.book_id, b.title, COUNT(l.loan_id) AS loan_count
       FROM Books b
       LEFT JOIN Loans l ON b.book_id = l.book_id
       GROUP BY b.book_id, b.title
       HAVING COUNT(l.loan_id) = 0
       ORDER BY b.book_id;`,
    );
    expect(unloanedBooks.results[0]?.rows?.map((r) => [r[0], r[1], Number(r[2])])).toEqual([
      [110, 'The Salt Merchant Ledger', 0],
      [112, 'Winter Over the Fjord', 0],
    ]);

    const authorWithoutBooks = await execSql(
      wsId,
      `SELECT a.author_id, a.full_name
       FROM Authors a
       LEFT JOIN BookAuthors ba ON a.author_id = ba.author_id
       WHERE ba.book_id IS NULL;`,
    );
    expect(authorWithoutBooks.results[0]?.rows).toEqual([[10, 'David Alvarez']]);

    // Self-join on nullable Members.referred_by
    const referrals = await execSql(
      wsId,
      `SELECT m.member_id, r.full_name AS referrer_name
       FROM Members m
       LEFT JOIN Members r ON m.referred_by = r.member_id
       WHERE m.member_id IN (201, 202)
       ORDER BY m.member_id;`,
    );
    expect(referrals.results[0]?.rows).toEqual([
      [201, null],
      [202, 'Nora Lindqvist'],
    ]);

    // UNION vs UNION ALL ('Nora Lindqvist' is both Author 1 and Member 201)
    const unionRes = await execSql(
      wsId,
      `SELECT full_name FROM Authors UNION SELECT full_name FROM Members;
       SELECT full_name FROM Authors UNION ALL SELECT full_name FROM Members;`,
    );
    expect(unionRes.results[0]?.rowCount).toBe(18);
    expect(unionRes.results[1]?.rowCount).toBe(19);

    // CREATE VIEW + query + schema introspection
    const viewRes = await execSql(
      wsId,
      `CREATE VIEW ActiveLoans AS
       SELECT l.loan_id, b.title, m.full_name AS borrower, l.due_date
       FROM Loans l
       INNER JOIN Books b ON l.book_id = b.book_id
       INNER JOIN Members m ON l.member_id = m.member_id
       WHERE l.returned_date IS NULL;

       SELECT loan_id, title, borrower FROM ActiveLoans ORDER BY loan_id;`,
    );
    expect(viewRes.results[0]?.kind).toBe('ok');
    expect(viewRes.results[1]?.rows).toEqual([
      [314, 'Distributed Systems Field Guide', 'Lucas Ferreira'],
      [315, 'Harbor of Glass', 'Anika Patel'],
    ]);

    const schemaRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${wsId}/schema`,
    });
    expect(schemaRes.statusCode).toBe(200);
    const tree = JSON.parse(schemaRes.body) as SchemaTree;
    expect(tree.tables.map((t) => t.name)).toEqual([
      'Authors',
      'BookAuthors',
      'Books',
      'Loans',
      'Members',
    ]);
    const totalFks = tree.tables.reduce((sum, t) => sum + t.foreignKeys.length, 0);
    expect(totalFks).toBe(5);
    expect(tree.views.map((v) => v.name)).toEqual(['ActiveLoans']);
  });

  it('preserves foreign keys and CHECK constraints on clone and rejects referenced DELETE with errno 1451', async () => {
    const { wsId, database } = await createWs('sample-library');

    const [tplFks] = await ctx.adminPool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS cnt FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = 'tpl_sample_library'",
    );
    const [wsFks] = await ctx.adminPool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?',
      [database],
    );
    expect(Number(wsFks[0]?.cnt)).toBe(Number(tplFks[0]?.cnt));
    expect(Number(wsFks[0]?.cnt)).toBe(5);

    const del = await execSql(wsId, 'DELETE FROM Authors WHERE author_id = 1;');
    expect(del.results[0]?.kind).toBe('error');
    expect(del.results[0]?.error?.errno).toBe(1451);

    const badDate = await execSql(
      wsId,
      "INSERT INTO Loans (loan_id, book_id, member_id, loaned_date, due_date, returned_date, late_fee) VALUES (999, 101, 201, '2025-10-10', '2025-10-10', NULL, NULL);",
    );
    expect(badDate.results[0]?.kind).toBe('error');
    expect(badDate.results[0]?.error?.errno).toBe(4025);
  });

  it('pins connections across requests: START TRANSACTION + UPDATE in req 1, ROLLBACK in req 2 restores data', async () => {
    const { wsId } = await createWs('sample-library');

    const r1 = await execSql(
      wsId,
      'START TRANSACTION; UPDATE Books SET copies_total = 99 WHERE book_id = 101; SELECT copies_total FROM Books WHERE book_id = 101;',
      'A',
    );
    expect(r1.txOpen).toBe(true);
    expect(r1.results[2]?.rows).toEqual([[99]]);

    // Session B does not see uncommitted change under READ COMMITTED
    const rB = await execSql(
      wsId,
      'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED; SELECT copies_total FROM Books WHERE book_id = 101;',
      'B',
    );
    expect(rB.results[1]?.rows).toEqual([[3]]);

    const r2 = await execSql(
      wsId,
      'ROLLBACK; SELECT copies_total FROM Books WHERE book_id = 101;',
      'A',
    );
    expect(r2.txOpen).toBe(false);
    expect(r2.results[1]?.rows).toEqual([[3]]);
  });

  it('enforces workspace isolation: blocks tpl_sample_library, INTO OUTFILE, cross-workspace access, and ~5s timeout', async () => {
    const ws1 = await createWs('sample-library');
    const ws2 = await createWs('sample-library');

    // 1. SELECT * FROM tpl_sample_library.Books denied by MariaDB privileges
    const tplAttempt = await execSql(ws1.wsId, 'SELECT * FROM tpl_sample_library.Books;');
    expect(tplAttempt.results[0]?.kind).toBe('error');
    expect(tplAttempt.results[0]?.error?.errno).toBe(1142);

    // 2. INTO OUTFILE denied by pre-flight denylist AND by MariaDB itself
    const outfileAttempt = await execSql(
      ws1.wsId,
      "SELECT * FROM Books INTO OUTFILE '/tmp/sql_scratchpad_blocked.txt';",
    );
    expect(outfileAttempt.results[0]?.kind).toBe('error');
    expect(outfileAttempt.results[0]?.error?.code).toBe('PLAYGROUND_DENIED');

    const entry = ctx.workspaceManager.getWorkspace(ws1.wsId);
    const directConn = await mysql.createConnection({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3307),
      user: entry.dbUser,
      password: entry.password,
      database: entry.database,
    });
    try {
      await expect(
        directConn.query("SELECT * FROM Books INTO OUTFILE '/tmp/sql_scratchpad_blocked2.txt'"),
      ).rejects.toMatchObject({ errno: 1227 });
    } finally {
      await directConn.end();
    }

    // 3. Two workspaces cannot see each other's tables
    const crossWs = await execSql(ws1.wsId, `SELECT * FROM \`${ws2.database}\`.Books;`);
    expect(crossWs.results[0]?.kind).toBe('error');
    expect(crossWs.results[0]?.error?.errno).toBe(1142);

    // 4. SELECT SLEEP(20) interrupted at ~5 s by MAX_STATEMENT_TIME 5
    const t0 = Date.now();
    const sleepRes = await execSql(ws1.wsId, 'SELECT SLEEP(20);');
    const elapsedMs = Date.now() - t0;
    expect(sleepRes.results[0]?.kind).toBe('error');
    expect([1969, 1317]).toContain(sleepRes.results[0]?.error?.errno);
    expect(elapsedMs).toBeGreaterThanOrEqual(4500);
    expect(elapsedMs).toBeLessThan(9000);
  });

  it('enforces per-session mutex (409) and supports KILL QUERY', async () => {
    const { wsId } = await createWs('empty');

    const sleepPromise = ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/exec`,
      payload: { sql: 'SELECT SLEEP(4);', session: 'A', stopOnError: true },
    });

    await new Promise((r) => setTimeout(r, 250));

    const busyRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/exec`,
      payload: { sql: 'SELECT 1;', session: 'A', stopOnError: true },
    });
    expect(busyRes.statusCode).toBe(409);
    expect(JSON.parse(busyRes.body)).toMatchObject({ error: { code: 'SESSION_BUSY' } });

    const killRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/sessions/A/kill`,
    });
    expect(killRes.statusCode).toBe(200);
    expect(JSON.parse(killRes.body)).toEqual({ ok: true });

    const sleepDone = await sleepPromise;
    expect(sleepDone.statusCode).toBe(200);
    const body = JSON.parse(sleepDone.body) as ExecResponse;
    expect(body.results[0]?.kind).toBe('error');
    expect(body.results[0]?.error?.errno).toBe(1317);
  });

  it('captures SHOW WARNINGS, respects stopOnError, caps rows at 1000, and resets workspaces', async () => {
    const { wsId } = await createWs('sample-library');

    const warnRes = await execSql(wsId, 'SELECT 1/0 AS div_zero;');
    expect(warnRes.results[0]?.kind).toBe('rows');
    expect(warnRes.results[0]?.warnings?.length).toBeGreaterThan(0);
    expect(warnRes.results[0]?.warnings?.[0]?.code).toBe(1365);

    const stopRes = await execSql(wsId, 'SELECT * FROM NonExistent; SELECT 1;', 'A', true);
    expect(stopRes.results).toHaveLength(1);
    expect(stopRes.results[0]?.kind).toBe('error');

    const contRes = await execSql(wsId, 'SELECT * FROM NonExistent; SELECT 1;', 'A', false);
    expect(contRes.results).toHaveLength(2);
    expect(contRes.results[0]?.kind).toBe('error');
    expect(contRes.results[1]?.kind).toBe('rows');

    // Row cap 1000 via cross-join (Books has 12 rows -> 12^3 = 1728 rows)
    const capRes = await execSql(
      wsId,
      'SELECT a.book_id FROM Books a CROSS JOIN Books b CROSS JOIN Books c;',
    );
    expect(capRes.results[0]?.rowCount).toBe(1000);
    expect(capRes.results[0]?.truncated).toBe(true);

    // Reset workspace to empty
    const resetRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/reset`,
      payload: { dataset: 'empty' },
    });
    expect(resetRes.statusCode).toBe(200);
    const schemaRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${wsId}/schema`,
    });
    const tree = JSON.parse(schemaRes.body) as SchemaTree;
    expect(tree.tables).toEqual([]);
  });

  it(
    'imports a 20,000-statement generated script in under 90 s on the workspace user',
    async () => {
      const { wsId } = await createWs('empty');

      const lines = [
        'CREATE TABLE bulk_items (id INTEGER PRIMARY KEY, label VARCHAR(40) NOT NULL);',
      ];
      for (let i = 1; i <= 19_999; i += 1) {
        lines.push(`INSERT INTO bulk_items (id, label) VALUES (${i}, 'item_${i}');`);
      }

      const { statusCode, body } = await importSql(wsId, lines.join('\n'), 'fresh');
      expect(statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.totalStatements).toBe(20_000);
      expect(body.statementsRun).toBe(20_000);
      expect(body.statementsOk).toBe(20_000);
      expect(body.durationMs).toBeLessThan(90_000);
      expect(body.tablesCreated).toEqual(['bulk_items']);

      const cnt = await execSql(wsId, 'SELECT COUNT(*) FROM bulk_items;');
      expect(cnt.results[0]?.rows).toEqual([[19_999]]);
    },
    120_000,
  );

  it('imports synthetic mysqldump with selective conditional skips, DEFINER stripping, views, and triggers', async () => {
    const { wsId } = await createWs('empty');

    const dumpSql = [
      '-- Synthetic mysqldump / phpMyAdmin fixture',
      '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
      '/*!40101 SET NAMES utf8mb4 */;',
      '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
      'CREATE DATABASE IF NOT EXISTS synthetic_demo;',
      'USE synthetic_demo;',
      'DROP DATABASE IF EXISTS old_demo;',
      'SET GLOBAL max_connections = 999;',
      'CREATE TABLE items (id INT PRIMARY KEY, name VARCHAR(60) NOT NULL);',
      'CREATE TABLE audit_log (id INT AUTO_INCREMENT PRIMARY KEY, item_id INT NOT NULL);',
      'LOCK TABLES items WRITE;',
      '/*!40000 ALTER TABLE items DISABLE KEYS */;',
      "INSERT INTO items VALUES (1, 'alpha'), (2, 'beta');",
      '/*!40000 ALTER TABLE items ENABLE KEYS */;',
      'UNLOCK TABLES;',
      '/*!50001 CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW v_items AS SELECT id, name FROM items */;',
      'DELIMITER ;;',
      "/*!50003 CREATE*/ /*!50017 DEFINER='admin'@'%'*/ /*!50003 TRIGGER trg_items_audit AFTER INSERT ON items FOR EACH ROW INSERT INTO audit_log (item_id) VALUES (NEW.id) */;;",
      'DELIMITER ;',
      "INSERT INTO items VALUES (3, 'gamma');",
      '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;',
      '/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;',
    ].join('\n');

    const { statusCode, body } = await importSql(wsId, dumpSql, 'fresh');
    expect(statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.skippedCount).toBe(13);
    expect(body.rewrittenCount).toBe(2);
    expect(body.rewritten.map((r) => r.startLine)).toEqual([16, 18]);
    expect(body.tablesCreated).toEqual(['audit_log', 'items']);

    const schemaRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/workspaces/${wsId}/schema`,
    });
    const tree = JSON.parse(schemaRes.body) as SchemaTree;
    expect(tree.views.map((v) => v.name)).toEqual(['v_items']);
    expect(tree.tables.find((t) => t.name === 'items')?.triggers).toEqual(['trg_items_audit']);

    const verify = await execSql(
      wsId,
      'SELECT COUNT(*) FROM v_items; SELECT item_id FROM audit_log;',
    );
    expect(verify.results[0]?.rows).toEqual([[3]]);
    expect(verify.results[1]?.rows).toEqual([[3]]);
  });

  it('stops on import error with exact line number and keeps earlier statements applied', async () => {
    const { wsId } = await createWs('empty');

    const badScript = [
      'CREATE TABLE partial_rows (id INT PRIMARY KEY);',
      'INSERT INTO partial_rows VALUES (1);',
      'INSERT INTO partial_rows VALUES (2);',
      'INSERT INTO nonexistent_table VALUES (3);',
      'INSERT INTO partial_rows VALUES (4);',
    ].join('\n');

    const { statusCode, body } = await importSql(wsId, badScript, 'fresh');
    expect(statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.statementsOk).toBe(3);
    expect(body.error).toMatchObject({
      index: 3,
      startLine: 4,
      errno: 1146,
      alreadyApplied: true,
    });
    expect(body.note).toContain('line 4');
    expect(body.note).toContain('remain applied');

    const cnt = await execSql(wsId, 'SELECT COUNT(*) FROM partial_rows;');
    expect(cnt.results[0]?.rows).toEqual([[2]]);
  });

  it('enforces import transaction safety: refuses append with open tx (409) and restores @@autocommit', async () => {
    const { wsId } = await createWs('sample-library');

    // 1. Open a transaction in session A -> append import must fail with 409 and leave tx intact
    const startTx = await execSql(
      wsId,
      'START TRANSACTION; UPDATE Books SET copies_total = 77 WHERE book_id = 101;',
      'A',
    );
    expect(startTx.txOpen).toBe(true);

    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/import`,
      payload: { sql: 'CREATE TABLE should_not_exist (id INT);', mode: 'append' },
    });
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body)).toEqual({
      error: {
        code: 'TRANSACTION_OPEN',
        message: 'Transaction open in session A — COMMIT or ROLLBACK first',
      },
    });

    // Confirm original transaction is still open and can roll back cleanly
    const rolledBack = await execSql(
      wsId,
      'ROLLBACK; SELECT copies_total FROM Books WHERE book_id = 101;',
      'A',
    );
    expect(rolledBack.txOpen).toBe(false);
    expect(rolledBack.results[1]?.rows).toEqual([[3]]);

    // 2. Set autocommit = 0 on session A, run a >50-statement batched append import, verify @@autocommit stays 0
    await execSql(wsId, 'SET autocommit = 0;', 'A');
    const batchLines = ['CREATE TABLE ac_test (id INT PRIMARY KEY);'];
    for (let i = 1; i <= 60; i += 1) {
      batchLines.push(`INSERT INTO ac_test VALUES (${i});`);
    }
    const appendRes = await importSql(wsId, batchLines.join('\n'), 'append');
    expect(appendRes.statusCode).toBe(200);
    expect(appendRes.body.ok).toBe(true);

    const acAfterAppend = await execSql(wsId, 'SELECT @@autocommit;', 'A');
    expect(Number(acAfterAppend.results[0]?.rows?.[0]?.[0])).toBe(0);

    // 3. Fresh import resets session (default autocommit = 1) and preserves @@autocommit = 1 afterwards
    const freshRes = await importSql(wsId, batchLines.join('\n'), 'fresh');
    expect(freshRes.statusCode).toBe(200);
    expect(freshRes.body.ok).toBe(true);

    const acAfterFresh = await execSql(wsId, 'SELECT @@autocommit;', 'A');
    expect(Number(acAfterFresh.results[0]?.rows?.[0]?.[0])).toBe(1);
  });

  it('enforces 256 KB /exec limit, 6 MB /import limit (413), 60k statement cap (400), and byte budget (429 + Retry-After)', async () => {
    const config = loadConfig({
      ...process.env,
      LOG_LEVEL: 'silent',
      IMPORT_BYTE_BUDGET_PER_HOUR: '2000',
    });
    const rlCtx = await buildApp({
      config,
      adminPool: ctx.adminPool,
      enableRateLimit: true,
    });
    const rlCreated: string[] = [];
    try {
      const wsRes = await rlCtx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        payload: { dataset: 'empty' },
      });
      expect(wsRes.statusCode).toBe(201);
      const { wsId } = JSON.parse(wsRes.body) as { wsId: string };
      rlCreated.push(wsId);

      // /exec > 256 KB -> 413
      const execBig = await rlCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${wsId}/exec`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ sql: 'A'.repeat(260 * 1024), session: 'A', stopOnError: true }),
      });
      expect(execBig.statusCode).toBe(413);

      // /import > 6 MB -> 413
      const importBig = await rlCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${wsId}/import`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ mode: 'fresh', sql: 'A'.repeat(6 * 1024 * 1024 + 128) }),
      });
      expect(importBig.statusCode).toBe(413);

      // Per-IP byte budget (configured to 2000 B here) -> 429 with Retry-After
      const okSmall = await rlCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${wsId}/import`,
        payload: { mode: 'append', sql: `SELECT '${'x'.repeat(1200)}';` },
      });
      expect(okSmall.statusCode).toBe(200);

      const overBudget = await rlCtx.app.inject({
        method: 'POST',
        url: `/api/workspaces/${wsId}/import`,
        payload: { mode: 'append', sql: `SELECT '${'y'.repeat(1200)}';` },
      });
      expect(overBudget.statusCode).toBe(429);
      expect(overBudget.headers['retry-after']).toBeDefined();
      expect(JSON.parse(overBudget.body)).toMatchObject({
        error: { code: 'IMPORT_BYTE_BUDGET_EXCEEDED' },
      });

      // Unknown workspace -> 404
      const missingRes = await rlCtx.app.inject({
        method: 'GET',
        url: '/api/workspaces/aaaaaaaaaaaaaaaaaaaaaaaaaa/schema',
      });
      expect(missingRes.statusCode).toBe(404);
    } finally {
      for (const id of rlCreated) {
        await rlCtx.app.inject({ method: 'DELETE', url: `/api/workspaces/${id}` });
      }
      await rlCtx.app.close();
    }

    // 60,001 statements -> 400 TOO_MANY_STATEMENTS (without modifying workspace)
    const { wsId: capWs } = await createWs('empty');
    const overCapSql = 'SELECT 1;\n'.repeat(60_001);
    const overCapRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/workspaces/${capWs}/import`,
      payload: { mode: 'fresh', sql: overCapSql },
    });
    expect(overCapRes.statusCode).toBe(400);
    expect(JSON.parse(overCapRes.body)).toMatchObject({
      error: { code: 'TOO_MANY_STATEMENTS' },
    });
  });
});
