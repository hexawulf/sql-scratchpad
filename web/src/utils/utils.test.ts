import { describe, expect, it } from 'vitest';
import type { StatementResult } from '@sql-scratchpad/shared';
import {
  classifySqlScriptForImport,
  containsDdlStatement,
  extractStatementAtCursor,
  isQueryOnlyScript,
  splitStatementsWithOffsets,
} from './sql-statement';
import { formatApiErrorForUser, formatStatementStatusLines } from './status-format';
import { ApiHttpError } from '../engines/mariadb';
import { formatCellText, isNumericColumnType, toMarkdownTable, toTsv } from './export-grid';
import {
  STORAGE_KEY,
  buildAutocommitSql,
  buildIsolationSql,
  buildOnlyFullGroupBySql,
  buildSafeUpdatesSql,
  buildStrictModeSql,
  createDefaultSettings,
  loadPersistedState,
  savePersistedState,
} from './storage';

describe('sql-statement utilities', () => {
  it('extracts the statement under the cursor respecting quotes and comments', () => {
    const script = [
      '-- first query',
      "SELECT 'a;b' AS s FROM Books;",
      'SELECT title FROM Books WHERE price > 30.00;',
    ].join('\n');

    const chunks = splitStatementsWithOffsets(script);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.startLine).toBe(2);
    expect(chunks[1]?.startLine).toBe(3);

    const secondOffset = script.indexOf('price');
    const extracted = extractStatementAtCursor(script, secondOffset);
    expect(extracted?.sql).toBe('SELECT title FROM Books WHERE price > 30.00;');
    expect(extracted?.startLine).toBe(3);
  });

  it('detects DDL statements and ignores failed statements', () => {
    const okDdl: StatementResult = {
      index: 0,
      sql: '-- create view\nCREATE VIEW v AS SELECT 1;',
      startLine: 2,
      kind: 'ok',
      affectedRows: 0,
      durationMs: 2,
    };
    const errDdl: StatementResult = { ...okDdl, kind: 'error' };
    const selectOnly: StatementResult = { ...okDdl, sql: 'SELECT * FROM Books;' };

    expect(containsDdlStatement([okDdl])).toBe(true);
    expect(containsDdlStatement([errDdl])).toBe(false);
    expect(containsDdlStatement([selectOnly])).toBe(false);
  });

  it('handles UTF-8 BOM in splitStatementsWithOffsets', () => {
    const script = '\uFEFF-- header\r\nSELECT 1;\r\nSELECT 2;';
    const chunks = splitStatementsWithOffsets(script);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.sql).toBe('SELECT 1;');
    expect(chunks[0]?.startLine).toBe(2);
    expect(chunks[1]?.sql).toBe('SELECT 2;');
    expect(chunks[1]?.startLine).toBe(3);
  });

  it('detects query-only scripts (SELECT, WITH...SELECT, SHOW, EXPLAIN, DESCRIBE, comments) vs DDL/DML scripts', () => {
    const queryOnlySamples = [
      '-- 1 -- lesson script\n-- select all rows\nSELECT *\nFROM Country;\nSELECT DISTINCT continent FROM Country;',
      '\uFEFF-- CRLF + BOM\r\nSHOW TABLES;\r\nEXPLAIN SELECT 1;\r\nDESCRIBE Country;\r\nDESC Country;',
      'WITH cte AS (SELECT 1 AS n) SELECT * FROM cte;',
      'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5) SELECT * FROM seq;',
      '(SELECT 1) UNION (SELECT 2);',
      'USE world;\n/*!40101 SET NAMES utf8mb4 */;\nSELECT * FROM Country;',
      '-- comments only\n/* block comment */\n# hash comment',
      '   \n\r\n  ',
    ];
    for (const sql of queryOnlySamples) {
      expect(isQueryOnlyScript(sql), sql).toBe(true);
    }

    const mutatingSamples = [
      'CREATE TABLE items (id INT PRIMARY KEY);',
      'INSERT INTO items VALUES (1);',
      'UPDATE items SET id = 2 WHERE id = 1;',
      'DELETE FROM items WHERE id = 2;',
      'DROP TABLE IF EXISTS items;',
      'ALTER TABLE items ADD COLUMN name VARCHAR(40);',
      'CREATE TABLE items (id INT);\nSELECT * FROM items;',
      '/*!50001 CREATE VIEW v AS SELECT 1 */;',
      'DELIMITER //\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; END //\nDELIMITER ;',
      'WITH doomed AS (SELECT 1 AS id) DELETE FROM items WHERE id IN (SELECT id FROM doomed);',
    ];
    for (const sql of mutatingSamples) {
      expect(isQueryOnlyScript(sql), sql).toBe(false);
    }

    const emptyMeta = classifySqlScriptForImport('-- only comments\n');
    expect(emptyMeta).toEqual({ statementCount: 0, isQueryOnly: true, isEmpty: true });
  });

  it('handles ReDoS-adversarial conditional comments and trailing semicolons in linear time [INJECTION-001]', () => {
    const spacesPayload = `/*!40101${' '.repeat(10_000)}SELECT 1`;
    const semisPayload = `DELIMITER //\nSELECT 1${';'.repeat(20_000)}x //\nDELIMITER ;`;
    const t0 = performance.now();
    expect(isQueryOnlyScript(spacesPayload)).toBe(true);
    expect(isQueryOnlyScript(semisPayload)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it('caps custom DELIMITER length to avoid quadratic CPU exhaustion [INJECTION-003]', () => {
    const longDelim = 'A'.repeat(4000) + 'B';
    const payload = `DELIMITER ${longDelim}\n${'A'.repeat(16_000)};\nSELECT 1;`;
    const t0 = performance.now();
    expect(isQueryOnlyScript(payload)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('status-format (Letos wording)', () => {
  it('formats row result in exact Letos wording', () => {
    const res: StatementResult = {
      index: 0,
      sql: 'SELECT * FROM Books;',
      startLine: 1,
      kind: 'rows',
      rowCount: 12,
      durationMs: 50.26,
    };
    const date = new Date(2026, 10, 19, 10, 48, 53);
    const lines = formatStatementStatusLines(res, date);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe(
      '[10:48:53] Query finished in 0.05026 second(s). Rows affected: 12',
    );
  });

  it('formats errors with errno/SQLSTATE and appends warnings', () => {
    const res: StatementResult = {
      index: 0,
      sql: 'DELETE FROM Authors WHERE author_id = 1;',
      startLine: 1,
      kind: 'error',
      error: {
        code: 'ER_ROW_IS_REFERENCED_2',
        errno: 1451,
        sqlState: '23000',
        message: 'Cannot delete or update a parent row',
      },
      warnings: [{ level: 'Warning', code: 1265, message: 'Data truncated' }],
      durationMs: 4,
    };
    const date = new Date(2026, 10, 19, 9, 5, 1);
    const lines = formatStatementStatusLines(res, date);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.message).toBe(
      '[09:05:01] ERROR 1451 (23000): Cannot delete or update a parent row',
    );
    expect(lines[1]?.level).toBe('warning');
    expect(lines[1]?.message).toBe('[09:05:01] Warning 1265: Data truncated');
  });

  it('formats 429 and 503 ApiHttpError messages with Retry-After in minutes', () => {
    const capErr = new ApiHttpError(
      429,
      'PER_IP_WORKSPACE_LIMIT',
      'You have reached the maximum of 6 active workspaces per IP. Close a workspace or wait for it to expire.',
      7200,
    );
    expect(formatApiErrorForUser(capErr)).toEqual({
      message:
        'You have reached the maximum of 6 active workspaces per IP. Close a workspace or wait for it to expire. Please try again in 120 minutes.',
      isRateLimitOrCapacity: true,
    });

    const shortErr = new ApiHttpError(429, 'RATE_LIMITED', 'Rate limit exceeded', 45);
    expect(formatApiErrorForUser(shortErr)).toEqual({
      message: 'Rate limit exceeded. Please try again in 1 minute.',
      isRateLimitOrCapacity: true,
    });

    const busyErr = new ApiHttpError(
      503,
      'WORKSPACE_LIMIT_REACHED',
      'SQL Scratchpad is busy, try again in a few minutes',
    );
    expect(formatApiErrorForUser(busyErr)).toEqual({
      message: 'SQL Scratchpad is busy, try again in a few minutes',
      isRateLimitOrCapacity: true,
    });

    const genericErr = new Error('Network down');
    expect(formatApiErrorForUser(genericErr)).toEqual({
      message: 'Network down',
      isRateLimitOrCapacity: false,
    });
  });
});

describe('export-grid utilities', () => {
  it('detects numeric column types and formats TSV and Markdown', () => {
    const cols = [
      { name: 'genre', type: 'VARCHAR' },
      { name: 'book_count', type: 'LONGLONG' },
    ];
    const rows = [
      ['Fiction', 3],
      ['Science', null],
    ];
    expect(isNumericColumnType('DECIMAL(6,2)')).toBe(true);
    expect(isNumericColumnType('VARCHAR')).toBe(false);
    expect(formatCellText(null)).toBe('NULL');
    expect(toTsv(cols, rows)).toBe('genre\tbook_count\nFiction\t3\nScience\tNULL');
    expect(toMarkdownTable(cols, rows)).toBe(
      '| genre | book_count |\n| --- | ---: |\n| Fiction | 3 |\n| Science | NULL |',
    );
  });
});

describe('storage and session toggle SQL', () => {
  it('persists and restores sql-scratchpad:v1 state', () => {
    const map = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const state = {
      wsId: 'abcdef123456',
      engine: 'mariadb' as const,
      dataset: 'sample-library',
      tabs: [{ id: 't1', title: 'library_queries.sql', sql: 'SELECT * FROM Books;', cursor: 5 }],
      activeTab: 't1',
      history: [
        {
          ts: '2026-11-19T10:00:00.000Z',
          engine: 'mariadb' as const,
          dataset: 'sample-library',
          sql: 'SELECT * FROM Books;',
          summary: '1 stmt(s), 12 row(s)',
        },
      ],
      settings: createDefaultSettings(),
    };

    savePersistedState(state, fakeStorage);
    expect(map.has(STORAGE_KEY)).toBe(true);
    expect(loadPersistedState(fakeStorage)).toEqual(state);
  });

  it('builds SET SESSION SQL for MariaDB session toggles', () => {
    expect(buildSafeUpdatesSql(true)).toBe('SET SESSION sql_safe_updates = 1;');
    expect(buildOnlyFullGroupBySql(true)).toContain('ONLY_FULL_GROUP_BY');
    expect(buildStrictModeSql(false)).toContain('STRICT_TRANS_TABLES');
    expect(buildIsolationSql('READ COMMITTED')).toBe(
      'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;',
    );
    expect(buildAutocommitSql(false)).toBe('SET autocommit = 0;');
  });
});
