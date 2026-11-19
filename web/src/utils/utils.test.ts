import { describe, expect, it } from 'vitest';
import type { StatementResult } from '@sqlyard/shared';
import {
  containsDdlStatement,
  extractStatementAtCursor,
  splitStatementsWithOffsets,
} from './sql-statement';
import { formatStatementStatusLines } from './status-format';
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
  it('persists and restores sqlyard:v1 state', () => {
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
