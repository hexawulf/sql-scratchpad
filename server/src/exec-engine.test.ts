import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Connection, FieldPacket, Pool } from 'mysql2/promise';
import type { FastifyBaseLogger } from 'fastify';
import {
  ExecEngine,
  checkDenylist,
  formatColumnType,
  splitMariaDbStatements,
  stripCommentsAndLiterals,
} from './exec-engine.js';
import { loadConfig } from './config.js';
import { ApiError } from './errors.js';
import { buildExecSleepLoopSql } from './fixtures/hostile-corpus.js';
import {
  ImportByteBudget,
  ImportEngine,
  buildImportErrorHint,
  classifyImportSkip,
  rewriteDefinerClauses,
} from './import-engine.js';
import {
  WorkspaceManager,
  topoSortTables,
  escapeGrantDbIdent,
  templateDbName,
  type PinnedSession,
  type WorkspaceEntry,
} from './workspace-manager.js';
import { PINO_REDACT_PATHS, sqlLogMeta } from './logger.js';

describe('splitMariaDbStatements', () => {
  it('splits multiple statements and preserves 1-based startLine', () => {
    const sql = [
      '-- leading comment',
      'SELECT 1;',
      '',
      "SELECT 'semi;colon' AS s;",
      '/* block; comment */',
      'SELECT 2;',
    ].join('\n');

    const stmts = splitMariaDbStatements(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]!.startLine).toBe(2);
    expect(stmts[1]!.sql).toContain("'semi;colon'");
    expect(stmts[1]!.startLine).toBe(4);
    expect(stmts[2]!.sql).toContain('SELECT 2');
  });

  it('skips comment-only scripts', () => {
    const stmts = splitMariaDbStatements('-- only a comment\n/* another */\n# hash');
    expect(stmts).toHaveLength(0);
  });

  it('handles custom DELIMITER // for triggers/routines', () => {
    const sql = [
      'DELIMITER //',
      'CREATE TRIGGER t_bi BEFORE INSERT ON T FOR EACH ROW',
      'BEGIN',
      '  SET NEW.x = 1;',
      'END //',
      'DELIMITER ;',
      'SELECT 42;',
    ].join('\n');

    const stmts = splitMariaDbStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toContain('CREATE TRIGGER t_bi');
    expect(stmts[0]!.sql).toContain('SET NEW.x = 1;');
    expect(stmts[1]!.sql).toBe('SELECT 42');
  });

  it('strips leading non-conditional comments so echoed sql agrees with startLine (LF, CRLF, block comments, BOM)', () => {
    const lfScript = [
      '-- 1 -- After explanation of select and from',
      '-- select all data records (rows) from a table',
      'SELECT *',
      'FROM Country;',
      'SELECT continent FROM Country;',
    ].join('\n');

    const lfStmts = splitMariaDbStatements(lfScript);
    expect(lfStmts).toHaveLength(2);
    expect(lfStmts[0]).toEqual({
      sql: 'SELECT *\nFROM Country',
      startLine: 3,
    });
    expect(lfStmts[1]).toEqual({
      sql: 'SELECT continent FROM Country',
      startLine: 5,
    });

    const crlfScript = [
      '\uFEFF-- 1 -- CRLF with UTF-8 BOM',
      '# hash comment',
      'SELECT *',
      'FROM Country;',
      '/* multi-line',
      '   block comment */',
      'SELECT continent FROM Country;',
    ].join('\r\n');

    const crlfStmts = splitMariaDbStatements(crlfScript);
    expect(crlfStmts).toHaveLength(2);
    expect(crlfStmts[0]).toEqual({
      sql: 'SELECT *\r\nFROM Country',
      startLine: 3,
    });
    expect(crlfStmts[1]).toEqual({
      sql: 'SELECT continent FROM Country',
      startLine: 7,
    });
  });

  it('preserves executable conditional comments while stripping preceding non-conditional comments', () => {
    const sql = [
      '/* dump header',
      '   note */',
      '/*!50001 CREATE VIEW v_demo AS SELECT 1 */;',
    ].join('\n');

    const stmts = splitMariaDbStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toEqual({
      sql: '/*!50001 CREATE VIEW v_demo AS SELECT 1 */',
      startLine: 3,
    });
  });

  it('handles UTF-8 BOM before DELIMITER on line 1', () => {
    const sql = [
      '\uFEFFDELIMITER //',
      'CREATE TRIGGER t_bom BEFORE INSERT ON x FOR EACH ROW',
      'BEGIN',
      '  SET NEW.a = 1;',
      'END //',
      'DELIMITER ;',
      'SELECT 1;',
    ].join('\n');

    const stmts = splitMariaDbStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.startLine).toBe(2);
    expect(stmts[0]!.sql).toContain('CREATE TRIGGER t_bom');
    expect(stmts[0]!.sql).toContain('SET NEW.a = 1;');
    expect(stmts[1]).toEqual({ sql: 'SELECT 1', startLine: 7 });
  });

  it('rejects overlong or control-char custom DELIMITER directives [INJECTION-003]', () => {
    const longDelim = 'A'.repeat(4000) + 'B';
    const hostile = `DELIMITER ${longDelim}\n${'A'.repeat(16_000)}`;
    const t0 = performance.now();
    expect(() => splitMariaDbStatements(hostile)).toThrowError(ApiError);
    try {
      splitMariaDbStatements(hostile);
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, code: 'INVALID_DELIMITER' });
    }
    expect(performance.now() - t0).toBeLessThan(100);
    expect(() => splitMariaDbStatements('DELIMITER a\x00b\nSELECT 1')).toThrowError(ApiError);
    // Delimiter up to 16 chars remains allowed
    expect(
      splitMariaDbStatements('DELIMITER 1234567890123456\nSELECT 1 1234567890123456'),
    ).toHaveLength(1);
  });
});

describe('buildImportErrorHint', () => {
  it('returns a contextual hint mentioning the dataset on ER_NO_SUCH_TABLE (1146)', () => {
    const emptyHint = buildImportErrorHint(1146, 'empty', false);
    expect(emptyHint).toBeDefined();
    expect(emptyHint).toContain("'empty'");
    expect(emptyHint).toMatch(/editor/i);

    const partialHint = buildImportErrorHint(1146, 'sample-library', true);
    expect(partialHint).toBeDefined();
    expect(partialHint).toContain("'sample-library'");

    expect(buildImportErrorHint(1064, 'empty', false)).toBeUndefined();
    expect(buildImportErrorHint(undefined, 'empty', false)).toBeUndefined();
  });
});

describe('stripCommentsAndLiterals & checkDenylist', () => {
  it('blocks disallowed admin/file/cross-db statements', () => {
    const blocked = [
      'GRANT ALL ON *.* TO x',
      'REVOKE SELECT ON ws_abc.* FROM x',
      'CREATE USER evil IDENTIFIED BY "pw"',
      'SET GLOBAL max_connections = 999',
      'SET @@GLOBAL.max_connections = 999',
      'INSTALL PLUGIN foo SONAME "bar.so"',
      'SHUTDOWN',
      "LOAD DATA INFILE '/etc/passwd' INTO TABLE t",
      "SELECT * FROM Books INTO OUTFILE '/tmp/out.txt'",
      "SELECT * FROM Books INTO DUMPFILE '/tmp/out.bin'",
      'USE tpl_sample_library',
      'USE `ws_other123456`',
    ];
    for (const sql of blocked) {
      expect(checkDenylist(sql, 'ws_111111111111'), sql).not.toBeNull();
    }
  });

  it('allows safe statements including denylist keywords inside strings/comments and USE own db', () => {
    const allowed = [
      "SELECT 'GRANT ALL', 'INTO OUTFILE', 'SHUTDOWN'",
      '-- SHUTDOWN\nSELECT 1',
      '/* GRANT ALL */ SELECT 1',
      'SET SESSION sql_safe_updates = 1',
      'USE ws_111111111111',
      'USE `ws_111111111111`',
    ];
    for (const sql of allowed) {
      expect(checkDenylist(sql, 'ws_111111111111'), sql).toBeNull();
    }
  });

  it('strips comments and literals cleanly', () => {
    expect(stripCommentsAndLiterals("SELECT 'a''b' -- c\nFROM T").replace(/\s+/g, ' ').trim()).toBe(
      'SELECT FROM T',
    );
  });

  it('evaluates CREATE FUNCTION ... SONAME denylist rule in linear time [INJECTION-002]', () => {
    const hostile = 'CREATE FUNCTION '.repeat(5_000);
    const t0 = performance.now();
    expect(checkDenylist(hostile, 'ws_111111111111')).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
    expect(
      checkDenylist(
        "CREATE OR REPLACE AGGREGATE FUNCTION f RETURNS INT SONAME 'x.so'",
        'ws_111111111111',
      ),
    ).toContain('SONAME');
  });

  it('blocks denylist bypasses via backticks, /*M!*/ comments, dynamic SQL, and NO_BACKSLASH_ESCAPES [INJECTION-004]', () => {
    const db = 'ws_111111111111';
    // Backtick identifier containing quote or comment start
    expect(checkDenylist("SELECT `a'`, BENCHMARK(100, 1), `'b`", db)).not.toBeNull();
    expect(checkDenylist('SELECT `x/*`, BENCHMARK(100, 1), `*/y`', db)).not.toBeNull();
    // MariaDB /*M! ... */ executable comment
    expect(checkDenylist('SELECT /*M!100000 BENCHMARK(100, 1) */', db)).not.toBeNull();
    // Dynamic SQL PREPARE / EXECUTE IMMEDIATE
    expect(checkDenylist("PREPARE s FROM 'SELECT BENCHMARK(100, 1)'", db)).not.toBeNull();
    expect(checkDenylist("EXECUTE IMMEDIATE 'SELECT BENCHMARK(100, 1)'", db)).not.toBeNull();
    // NO_BACKSLASH_ESCAPES trailing backslash
    expect(checkDenylist("SELECT '\\', BENCHMARK(100, 1), ''", db)).not.toBeNull();
    // @@PERSIST. / @@PERSIST_ONLY.
    expect(checkDenylist('SET @@PERSIST.max_connections = 999', db)).not.toBeNull();
    expect(checkDenylist('SET @@PERSIST_ONLY.max_connections = 999', db)).not.toBeNull();
  });

  it('blocks advisory locks, global metadata queries, and DATA/INDEX DIRECTORY [AUTHZ-004, AUTHZ-006]', () => {
    const db = 'ws_111111111111';
    for (const sql of [
      "SELECT GET_LOCK('shared', 1)",
      "SELECT RELEASE_LOCK('shared')",
      'SELECT RELEASE_ALL_LOCKS()',
      "SELECT IS_FREE_LOCK('shared')",
      "SELECT IS_USED_LOCK('shared')",
      'SHOW GLOBAL STATUS',
      'SHOW GLOBAL VARIABLES',
      'SELECT * FROM information_schema.GLOBAL_STATUS',
      'SELECT * FROM information_schema.GLOBAL_VARIABLES',
      'SELECT * FROM information_schema.PLUGINS',
      "CREATE TABLE t (id INT) DATA DIRECTORY = '/tmp'",
      "CREATE TABLE t (id INT) INDEX DIRECTORY = '/tmp'",
    ]) {
      expect(checkDenylist(sql, db), sql).not.toBeNull();
    }
    // Session-scoped metadata remains allowed
    expect(checkDenylist('SHOW SESSION VARIABLES', db)).toBeNull();
  });
});

describe('import helpers: classifyImportSkip, rewriteDefinerClauses, ImportByteBudget', () => {
  it('skips dump headers, DB-level DDL, SET GLOBAL, LOCK/UNLOCK, and session/charset conditional comments only', () => {
    const shouldSkip = [
      '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */',
      '/*!40101 SET NAMES utf8mb4 */',
      '/*!40103 SET TIME_ZONE="+00:00" */',
      '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */',
      '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */',
      '/*!40101 SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO" */',
      '/*!40111 SET SQL_NOTES=0 */',
      '/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */',
      '/*!40000 ALTER TABLE `items` DISABLE KEYS */',
      '/*!40000 ALTER TABLE items ENABLE KEYS */',
      'CREATE DATABASE IF NOT EXISTS demo',
      'DROP DATABASE IF EXISTS demo',
      'USE demo',
      'SET GLOBAL max_connections = 200',
      'LOCK TABLES items WRITE',
      'UNLOCK TABLES',
    ];
    for (const sql of shouldSkip) {
      expect(classifyImportSkip(sql), sql).not.toBeNull();
    }

    const shouldExecute = [
      'CREATE TABLE items (id INT PRIMARY KEY)',
      'INSERT INTO items VALUES (1)',
      '/*!50001 CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW v AS SELECT 1 */',
      '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg AFTER INSERT ON items FOR EACH ROW INSERT INTO log VALUES (NEW.id) */',
      '/*!50003 CREATE PROCEDURE p() BEGIN SELECT 1; END */',
      'GRANT ALL ON *.* TO evil',
    ];
    for (const sql of shouldExecute) {
      expect(classifyImportSkip(sql), sql).toBeNull();
    }
  });

  it('strips DEFINER (any quoting) and SQL SECURITY DEFINER from VIEW/TRIGGER/PROCEDURE/FUNCTION/EVENT', () => {
    const viewRes = rewriteDefinerClauses(
      '/*!50001 CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW v_books AS SELECT 1 */',
    );
    expect(viewRes.reason).toBe('Stripped DEFINER clause; Stripped SQL SECURITY DEFINER');
    expect(viewRes.sql).not.toMatch(/DEFINER/i);
    expect(viewRes.sql).toContain('VIEW v_books AS SELECT 1');

    const trigRes = rewriteDefinerClauses(
      "/*!50003 CREATE*/ /*!50017 DEFINER='admin'@'%'*/ /*!50003 TRIGGER trg_a AFTER INSERT ON t FOR EACH ROW SET @x = 1 */",
    );
    expect(trigRes.reason).toBe('Stripped DEFINER clause');
    expect(trigRes.sql).not.toMatch(/DEFINER/i);
    expect(trigRes.sql).toContain('TRIGGER trg_a');

    const procRes = rewriteDefinerClauses(
      'CREATE DEFINER="svc"@"127.0.0.1" PROCEDURE p_demo() SQL SECURITY DEFINER BEGIN SELECT 1; END',
    );
    expect(procRes.reason).toBe('Stripped DEFINER clause; Stripped SQL SECURITY DEFINER');
    expect(procRes.sql).not.toMatch(/DEFINER/i);

    const unquotedFn = rewriteDefinerClauses(
      'CREATE DEFINER=root@localhost FUNCTION f_one() RETURNS INT RETURN 1',
    );
    expect(unquotedFn.reason).toBe('Stripped DEFINER clause');
    expect(unquotedFn.sql).not.toMatch(/DEFINER/i);

    // Must not touch CREATE TABLE even if a column default mentions DEFINER
    const tableRes = rewriteDefinerClauses(
      "CREATE TABLE docs (id INT PRIMARY KEY, note VARCHAR(60) DEFAULT 'DEFINER=root@localhost')",
    );
    expect(tableRes.reason).toBeNull();
    expect(tableRes.sql).toContain("'DEFINER=root@localhost'");
  });

  it('enforces rolling per-IP byte budget with retry-after calculation', () => {
    const budget = new ImportByteBudget(1000, 60_000);
    const t0 = 1_000_000;

    expect(budget.consume('10.0.0.1', 600, t0)).toEqual({ allowed: true, remainingBytes: 400 });
    expect(budget.consume('10.0.0.1', 400, t0 + 10_000)).toEqual({
      allowed: true,
      remainingBytes: 0,
    });

    const denied = budget.consume('10.0.0.1', 200, t0 + 20_000);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      // First entry (600 B) expires at t0 + 60_000 => 40 s remaining from t0 + 20_000
      expect(denied.retryAfterSec).toBe(40);
    }

    // Separate IP has its own budget
    expect(budget.consume('10.0.0.2', 500, t0 + 20_000)).toEqual({
      allowed: true,
      remainingBytes: 500,
    });

    // After first entry expires, 600 B is freed
    expect(budget.consume('10.0.0.1', 500, t0 + 61_000)).toEqual({
      allowed: true,
      remainingBytes: 100,
    });
  });

  it('classifies ReDoS-adversarial conditional comments and trailing semicolons in linear time [INJECTION-001]', () => {
    const spacesPayload = `/*!40101${' '.repeat(10_000)}SELECT 1`;
    const semisPayload = `SELECT 1${';'.repeat(20_000)}x`;
    const t0 = performance.now();
    expect(classifyImportSkip(spacesPayload)).toBeNull();
    expect(classifyImportSkip(semisPayload)).toBeNull();
    expect(classifyImportSkip('/*M!100000 SET NAMES utf8mb4 */')).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('topoSortTables & helpers', () => {
  it('orders parent tables before child tables', () => {
    const tables = ['Loans', 'BookAuthors', 'Books', 'Authors', 'Members'];
    const edges = [
      { table: 'BookAuthors', refTable: 'Books' },
      { table: 'BookAuthors', refTable: 'Authors' },
      { table: 'Loans', refTable: 'Books' },
      { table: 'Loans', refTable: 'Members' },
      { table: 'Members', refTable: 'Members' },
    ];
    const ordered = topoSortTables(tables, edges);
    expect(ordered.indexOf('Books')).toBeLessThan(ordered.indexOf('BookAuthors'));
    expect(ordered.indexOf('Authors')).toBeLessThan(ordered.indexOf('BookAuthors'));
    expect(ordered.indexOf('Books')).toBeLessThan(ordered.indexOf('Loans'));
    expect(ordered.indexOf('Members')).toBeLessThan(ordered.indexOf('Loans'));
  });

  it('maps dataset ids with hyphens to underscore template database names', () => {
    expect(templateDbName('sample-library')).toBe('tpl_sample_library');
  });

  it('escapes underscores and percent in MariaDB GRANT database names', () => {
    expect(escapeGrantDbIdent('ws_0123456789ab')).toBe('`ws\\_0123456789ab`');
  });

  it('maps mysql2 field types accurately', () => {
    expect(formatColumnType({ columnType: 3, characterSet: 63 } as FieldPacket)).toBe('INT');
    expect(formatColumnType({ columnType: 246, characterSet: 63 } as FieldPacket)).toBe('DECIMAL');
    expect(formatColumnType({ columnType: 253, characterSet: 45 } as FieldPacket)).toBe('VARCHAR');
    expect(formatColumnType({ columnType: 253, characterSet: 63 } as FieldPacket)).toBe(
      'VARBINARY',
    );
    expect(formatColumnType({ columnType: 252, characterSet: 45 } as FieldPacket)).toBe('TEXT');
    expect(formatColumnType({ columnType: 252, characterSet: 63 } as FieldPacket)).toBe('BLOB');
  });

  it('hashes SQL for logs without leaking raw SQL text', () => {
    const meta = sqlLogMeta('SELECT title FROM Books;');
    expect(meta.sqlLength).toBe(24);
    expect(meta.sqlSha256).toMatch(/^[0-9a-f]{16}$/);
    expect(PINO_REDACT_PATHS).toContain('sql');
    expect(PINO_REDACT_PATHS).toContain('req.body.sql');
    expect(PINO_REDACT_PATHS).toContain('password');
  });
});

describe('ExecEngine wall-clock timeout, statement cap, and janitor absolute TTL [API-001]', () => {
  const baseConfig = loadConfig({
    SQLSCRATCHPAD_ADMIN_PASSWORD: 'test-password',
    LOG_LEVEL: 'silent',
    EXEC_TIMEOUT_MS: '60',
    EXEC_MAX_STATEMENTS: '5',
  });

  function makeMockWorkspaceEntry(): WorkspaceEntry {
    const now = Date.now();
    return {
      wsId: 'wsid12345678',
      database: 'ws_0123456789ab',
      dbUser: 'ws_0123456789ab',
      password: 'pw',
      dataset: 'empty',
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + 60_000,
      absoluteExpiresAt: now + 60_000,
      sessions: {},
      sessionLocks: {},
      sessionWaiters: {},
      sessionAbort: {},
      teardownActive: false,
      deleting: false,
    };
  }

  it('rejects /exec batches exceeding EXEC_MAX_STATEMENTS', async () => {
    const ws = makeMockWorkspaceEntry();
    const session: PinnedSession = {
      id: 'A',
      conn: {
        query: async () => [[], []],
        end: async () => {},
        destroy: () => {},
      } as unknown as Connection,
      threadId: 42,
      busy: true,
      lastUsedAt: Date.now(),
    };
    const fakeWm = {
      getWorkspace: () => ws,
      touchWorkspace: () => {},
      acquireSession: async () => session,
      releaseSession: () => {},
      isSessionAbortRequested: () => false,
    } as unknown as WorkspaceManager;

    const engine = new ExecEngine(fakeWm, baseConfig);
    await expect(
      engine.execute(ws.wsId, {
        sql: 'SELECT 1; SELECT 2; SELECT 3; SELECT 4; SELECT 5; SELECT 6;',
        session: 'A',
        stopOnError: true,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'TOO_MANY_STATEMENTS' } as Partial<ApiError>);
  });

  it('stops batch execution with EXEC_TIMEOUT once wall-clock budget is exhausted', async () => {
    const ws = makeMockWorkspaceEntry();
    const cfg = loadConfig({
      SQLSCRATCHPAD_ADMIN_PASSWORD: 'test-password',
      LOG_LEVEL: 'silent',
      EXEC_TIMEOUT_MS: '50',
      EXEC_MAX_STATEMENTS: '200',
    });
    let executedUserQueries = 0;
    const session: PinnedSession = {
      id: 'A',
      conn: {
        query: async (arg: string | { sql: string }) => {
          const sql = typeof arg === 'string' ? arg : arg.sql;
          if (sql.startsWith('SET SESSION') || sql === 'SHOW WARNINGS') return [[], []];
          if (sql.includes('@@in_transaction')) return [[{ in_tx: 0 }], []];
          executedUserQueries += 1;
          await new Promise((r) => setTimeout(r, 30));
          return [[[1]], [{ name: 'c', columnType: 3, characterSet: 63 }]];
        },
        end: async () => {},
        destroy: () => {},
      } as unknown as Connection,
      threadId: 42,
      busy: true,
      lastUsedAt: Date.now(),
    };
    const fakeWm = {
      getWorkspace: () => ws,
      touchWorkspace: () => {},
      acquireSession: async () => session,
      releaseSession: () => {},
      isSessionAbortRequested: () => false,
    } as unknown as WorkspaceManager;

    const engine = new ExecEngine(fakeWm, cfg);
    const res = await engine.execute(ws.wsId, {
      sql: buildExecSleepLoopSql(20),
      session: 'A',
      stopOnError: false,
    });
    expect(executedUserQueries).toBeLessThan(20);
    const last = res.results[res.results.length - 1];
    expect(last?.kind).toBe('error');
    expect(last?.error?.code).toBe('EXEC_TIMEOUT');
  });

  it('forces janitor teardown on busy workspaces past absoluteExpiresAt instead of skipping', async () => {
    const killedThreads: number[] = [];
    const fakeConn = {
      query: async () => [[], []],
      release: () => {},
    };
    const fakePool = {
      query: async (sql: string) => {
        const m = /^KILL QUERY (\d+)$/.exec(sql);
        if (m) {
          killedThreads.push(Number(m[1]));
          // Simulate query abort releasing session lock
          ws.sessionLocks.A = false;
          if (ws.sessions.A) ws.sessions.A.busy = false;
          wm.releaseSession(ws, 'A', ws.sessions.A);
        }
        return [[], []];
      },
      getConnection: async () => fakeConn,
    } as unknown as Pool;
    const silentLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as FastifyBaseLogger;

    const wm = new WorkspaceManager(fakePool, baseConfig, [], silentLogger);
    const ws = makeMockWorkspaceEntry();
    ws.expiresAt = Date.now() - 10_000;
    ws.absoluteExpiresAt = Date.now() - 1_000;
    ws.sessionLocks.A = true;
    ws.sessions.A = {
      id: 'A',
      conn: { end: async () => {}, destroy: () => {} } as unknown as Connection,
      threadId: 777,
      busy: true,
      lastUsedAt: Date.now(),
    };
    (wm as unknown as { workspaces: Map<string, WorkspaceEntry> }).workspaces.set(ws.wsId, ws);

    const sweep = await wm.runJanitorSweep();
    expect(killedThreads).toContain(777);
    expect(sweep.expiredWorkspaces).toBe(1);
    expect(wm.getWorkspaceCount()).toBe(0);
  });
});

describe('Streaming row caps in ExecEngine and ImportEngine [API-002]', () => {
  function makeWs(): WorkspaceEntry {
    const now = Date.now();
    return {
      wsId: 'wsidstreaming1',
      database: 'ws_0123456789ab',
      dbUser: 'ws_0123456789ab',
      password: 'pw',
      dataset: 'empty',
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + 60_000,
      absoluteExpiresAt: now + 60_000,
      sessions: {},
      sessionLocks: {},
      sessionWaiters: {},
      sessionAbort: {},
      teardownActive: false,
      deleting: false,
    };
  }

  it('streams rows, enforces RESPONSE_CAP_BYTES mid-stream, kills query, and tolerates ER_QUERY_INTERRUPTED', async () => {
    const ws = makeWs();
    const cfg = loadConfig({
      SQLSCRATCHPAD_ADMIN_PASSWORD: 'test-password',
      LOG_LEVEL: 'silent',
      ROW_CAP: '100',
      RESPONSE_CAP_BYTES: '1024',
    });

    let killCalls = 0;
    const rawConn = {
      query: () => {
        const ee = new EventEmitter();
        queueMicrotask(() => {
          ee.emit('fields', [{ name: 'payload', columnType: 253, characterSet: 45 }]);
          // Emit 50 rows of 300 bytes each; should truncate after 3 rows (< 1024 B) and kill
          for (let r = 0; r < 50; r += 1) {
            ee.emit('result', ['X'.repeat(300)]);
          }
          const interrupted = Object.assign(new Error('Query execution was interrupted'), {
            errno: 1317,
            code: 'ER_QUERY_INTERRUPTED',
          });
          ee.emit('error', interrupted);
          ee.emit('end');
        });
        return ee;
      },
    };
    const session: PinnedSession = {
      id: 'A',
      conn: {
        connection: rawConn,
        query: async (sql: string) => {
          if (sql.includes('@@in_transaction')) return [[{ in_tx: 0 }], []];
          return [[], []];
        },
        end: async () => {},
        destroy: () => {},
      } as unknown as Connection,
      threadId: 99,
      busy: true,
      lastUsedAt: Date.now(),
    };
    const fakeWm = {
      getWorkspace: () => ws,
      touchWorkspace: () => {},
      acquireSession: async () => session,
      releaseSession: () => {},
      isSessionAbortRequested: () => false,
      killSessionQuery: async () => {
        killCalls += 1;
      },
    } as unknown as WorkspaceManager;

    const engine = new ExecEngine(fakeWm, cfg);
    const res = await engine.execute(ws.wsId, {
      sql: "SELECT REPEAT('X', 300);",
      session: 'A',
      stopOnError: true,
    });
    expect(killCalls).toBe(1);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.kind).toBe('rows');
    expect(res.results[0]?.truncated).toBe(true);
    expect(res.results[0]?.rowCount).toBeLessThanOrEqual(3);
  });

  it('streams and discards SELECT rows in ImportEngine and kills oversized result streams', async () => {
    const ws = makeWs();
    const cfg = loadConfig({
      SQLSCRATCHPAD_ADMIN_PASSWORD: 'test-password',
      LOG_LEVEL: 'silent',
      RESPONSE_CAP_BYTES: '1024',
    });

    let killCalls = 0;
    const rawConn = {
      query: () => {
        const ee = new EventEmitter();
        queueMicrotask(() => {
          ee.emit('fields', [{ name: 'big', columnType: 253, characterSet: 45 }]);
          for (let r = 0; r < 10; r += 1) {
            ee.emit('result', ['Y'.repeat(500)]);
          }
          const interrupted = Object.assign(new Error('Query execution was interrupted'), {
            errno: 1317,
            code: 'ER_QUERY_INTERRUPTED',
          });
          ee.emit('error', interrupted);
        });
        return ee;
      },
    };
    const session: PinnedSession = {
      id: 'A',
      conn: {
        connection: rawConn,
        query: async (sql: string) => {
          if (sql.includes('@@in_transaction')) return [[{ in_tx: 0, auto_c: 1 }], []];
          return [[], []];
        },
        end: async () => {},
        destroy: () => {},
      } as unknown as Connection,
      threadId: 101,
      busy: true,
      lastUsedAt: Date.now(),
    };
    const fakeWm = {
      getWorkspace: () => ws,
      touchWorkspace: () => {},
      acquireSession: async () => session,
      releaseSession: () => {},
      isSessionAbortRequested: () => false,
      killSessionQuery: async () => {
        killCalls += 1;
      },
    } as unknown as WorkspaceManager;

    const importer = new ImportEngine(fakeWm, cfg);
    const res = await importer.importSql(ws.wsId, {
      sql: "SELECT REPEAT('Y', 500);",
      mode: 'append',
    });
    expect(res.ok).toBe(true);
    expect(killCalls).toBe(1);
    expect(res.statementsOk).toBe(1);
  });
});

describe('WorkspaceManager synchronous capacity reservation [LOGIC-002]', () => {
  it('enforces MAX_WORKSPACES_PER_IP under concurrent createWorkspace calls', async () => {
    const cfg = loadConfig({
      SQLSCRATCHPAD_ADMIN_PASSWORD: 'test-password',
      LOG_LEVEL: 'silent',
      MAX_WORKSPACES_PER_IP: '2',
      MAX_WORKSPACES: '10',
    });
    const fakeConn = {
      query: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return [[], []];
      },
      release: () => {},
    };
    const fakePool = {
      query: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return [[], []];
      },
      getConnection: async () => fakeConn,
    } as unknown as Pool;
    const silentLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as FastifyBaseLogger;

    const wm = new WorkspaceManager(
      fakePool,
      cfg,
      [{ id: 'empty', title: 'Empty', description: 'Empty', tables: [], engines: ['mariadb'] }],
      silentLogger,
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => wm.createWorkspace('empty', 'ownerhash1234567', false)),
    );
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(8);
    expect(wm.getWorkspaceCount()).toBe(2);
  });
});

describe('In-path storage cap and janitor busy-oversized enforcement [LOGIC-003]', () => {
  const cfg = loadConfig({
    SQLSCRATCHPAD_ADMIN_PASSWORD: 'test-password',
    LOG_LEVEL: 'silent',
    MAX_WORKSPACE_BYTES: '1024',
  });

  function makeWs(): WorkspaceEntry {
    const now = Date.now();
    return {
      wsId: 'wsidstorage123',
      database: 'ws_storage1234',
      dbUser: 'ws_storage1234',
      password: 'pw',
      dataset: 'empty',
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + 60_000,
      absoluteExpiresAt: now + 60_000,
      sessions: {},
      sessionLocks: {},
      sessionWaiters: {},
      sessionAbort: {},
      teardownActive: false,
      deleting: false,
    };
  }

  it('rejects /exec with 507 WORKSPACE_STORAGE_LIMIT and aborts /import when schema exceeds MAX_WORKSPACE_BYTES', async () => {
    const ws = makeWs();
    const session: PinnedSession = {
      id: 'A',
      conn: {
        query: async (arg: string | { sql: string }) => {
          const sql = typeof arg === 'string' ? arg : arg.sql;
          if (sql.includes('data_length + index_length')) {
            return [[{ bytes: 2048 }], []];
          }
          if (sql.includes('@@in_transaction')) return [[{ in_tx: 0, auto_c: 1 }], []];
          return [[], []];
        },
        end: async () => {},
        destroy: () => {},
      } as unknown as Connection,
      threadId: 55,
      busy: true,
      lastUsedAt: Date.now(),
    };
    const fakeWm = {
      getWorkspace: () => ws,
      touchWorkspace: () => {},
      acquireSession: async () => session,
      releaseSession: () => {},
      isSessionAbortRequested: () => false,
    } as unknown as WorkspaceManager;

    const execEngine = new ExecEngine(fakeWm, cfg);
    await expect(
      execEngine.execute(ws.wsId, { sql: 'SELECT 1;', session: 'A', stopOnError: true }),
    ).rejects.toMatchObject({ statusCode: 507, code: 'WORKSPACE_STORAGE_LIMIT' });

    const importEngine = new ImportEngine(fakeWm, cfg);
    const importRes = await importEngine.importSql(ws.wsId, {
      sql: 'CREATE TABLE t (id INT);',
      mode: 'append',
    });
    expect(importRes.ok).toBe(false);
    expect(importRes.error?.code).toBe('WORKSPACE_STORAGE_LIMIT');
  });

  it('janitor interrupts and resets busy oversized workspaces instead of skipping them', async () => {
    const killedThreads: number[] = [];
    const fakeConn = {
      query: async () => [[], []],
      release: () => {},
    };
    const fakePool = {
      query: async (sql: string) => {
        if (sql.includes('data_length + index_length')) {
          return [[{ table_schema: 'ws_storage1234', bytes: 2048 }], []];
        }
        const m = /^KILL QUERY (\d+)$/.exec(sql);
        if (m) {
          killedThreads.push(Number(m[1]));
          ws.sessionLocks.A = false;
          if (ws.sessions.A) ws.sessions.A.busy = false;
          wm.releaseSession(ws, 'A', ws.sessions.A);
        }
        return [[], []];
      },
      getConnection: async () => fakeConn,
    } as unknown as Pool;
    const silentLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as FastifyBaseLogger;

    const wm = new WorkspaceManager(
      fakePool,
      cfg,
      [{ id: 'empty', title: 'Empty', description: 'Empty', tables: [], engines: ['mariadb'] }],
      silentLogger,
    );
    const ws = makeWs();
    ws.sessionLocks.A = true;
    ws.sessions.A = {
      id: 'A',
      conn: { end: async () => {}, destroy: () => {} } as unknown as Connection,
      threadId: 888,
      busy: true,
      lastUsedAt: Date.now(),
    };
    (wm as unknown as { workspaces: Map<string, WorkspaceEntry> }).workspaces.set(ws.wsId, ws);

    const sweep = await wm.runJanitorSweep();
    expect(killedThreads).toContain(888);
    expect(sweep.truncatedWorkspaces).toBe(1);
  });
});
