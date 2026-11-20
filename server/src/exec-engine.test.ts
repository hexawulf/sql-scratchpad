import { describe, expect, it } from 'vitest';
import type { FieldPacket } from 'mysql2/promise';
import {
  checkDenylist,
  formatColumnType,
  splitMariaDbStatements,
  stripCommentsAndLiterals,
} from './exec-engine.js';
import {
  ImportByteBudget,
  buildImportErrorHint,
  classifyImportSkip,
  rewriteDefinerClauses,
} from './import-engine.js';
import { topoSortTables, escapeGrantDbIdent, templateDbName } from './workspace-manager.js';
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
