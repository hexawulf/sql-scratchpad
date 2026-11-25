import type { EventEmitter } from 'node:events';
import { splitQuery, mysqlSplitterOptions } from 'dbgate-query-splitter';

interface RichSplitItem {
  text: string;
  trimStart: { position: number; line: number; column: number };
}
import type { FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type {
  ColumnMeta,
  ExecRequest,
  ExecResponse,
  StatementResult,
  StatementWarning,
} from '@sql-scratchpad/shared';
import type { AppConfig } from './config.js';
import { ApiError } from './errors.js';
import type { WorkspaceManager } from './workspace-manager.js';

export interface SplitStatement {
  sql: string;
  startLine: number;
}

/**
 * Strip SQL comments and string literals (replacing them with spaces) for safe denylist inspection.
 */
export function stripCommentsAndLiterals(sql: string, backslashEscapes = true): string {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;
    const next = i + 1 < n ? sql[i + 1] : '';

    // Single-line -- comment
    if (ch === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]!))) {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    // Single-line # comment (MySQL/MariaDB)
    if (ch === '#') {
      i += 1;
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    // Block comment /* ... */ (keep executable /*! ... */ and MariaDB /*M! ... */ inspectable)
    if (ch === '/' && next === '*') {
      if (i + 2 < n && sql[i + 2] === '!') {
        // Conditional comment: inspect inner tokens
        i += 3;
        while (i < n && /[0-9]/.test(sql[i]!)) i += 1;
        out += ' ';
        continue;
      }
      if (i + 3 < n && sql[i + 2] === 'M' && sql[i + 3] === '!') {
        // MariaDB-specific executable comment /*M!NNNNN ... */: inspect inner tokens
        i += 4;
        while (i < n && /[0-9]/.test(sql[i]!)) i += 1;
        out += ' ';
        continue;
      }
      i += 2;
      while (i < n && !(sql[i] === '*' && i + 1 < n && sql[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      out += ' ';
      continue;
    }

    // Closing of conditional comment
    if (ch === '*' && next === '/') {
      i += 2;
      out += ' ';
      continue;
    }

    // Backtick-quoted identifier (`` doubles literal backtick; backslash is NOT an escape)
    if (ch === '`') {
      const start = i + 1;
      i += 1;
      while (i < n) {
        if (sql[i] === '`') {
          if (i + 1 < n && sql[i + 1] === '`') {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      const inner = sql.slice(start, i);
      if (i < n && sql[i] === '`') i += 1;
      // Preserve simple alphanumeric identifiers (needed for `USE \`db\`` check); neutralize complex ones
      out += /^[A-Za-z0-9_$-]+$/.test(inner) ? `\`${inner}\`` : ' ';
      continue;
    }

    // Single-quoted or double-quoted string literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (backslashEscapes && sql[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Strip leading whitespace (including UTF-8 BOM) and non-conditional comments
 * (`--`, `#`, `/* ... *\/`) while preserving executable conditional comments
 * (`/*! ... *\/`) and counting the exact number of skipped newlines.
 */
function stripLeadingNonConditionalComments(sql: string): {
  sql: string;
  skippedNewlines: number;
} {
  let i = 0;
  let skippedNewlines = 0;
  const n = sql.length;

  while (i < n) {
    while (i < n && /\s/.test(sql[i]!)) {
      if (sql[i] === '\n') skippedNewlines += 1;
      i += 1;
    }
    if (i >= n) break;

    const ch = sql[i]!;
    const next = i + 1 < n ? sql[i + 1] : '';

    if (ch === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]!))) {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '#') {
      i += 1;
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (
      ch === '/' &&
      next === '*' &&
      sql[i + 2] !== '!' &&
      !(sql[i + 2] === 'M' && sql[i + 3] === '!')
    ) {
      i += 2;
      while (i < n && !(sql[i] === '*' && i + 1 < n && sql[i + 1] === '/')) {
        if (sql[i] === '\n') skippedNewlines += 1;
        i += 1;
      }
      i += 2;
      continue;
    }

    break;
  }

  return { sql: sql.slice(i).trim(), skippedNewlines };
}

const MAX_DELIMITER_LENGTH = 16;

function validateCustomDelimiters(sql: string): void {
  const n = sql.length;
  let pos = 0;
  while (pos < n) {
    let lineEnd = sql.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = n;
    let i = pos;
    while (i < lineEnd) {
      const ch = sql[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        i += 1;
        continue;
      }
      if (ch === '/' && i + 1 < lineEnd && sql[i + 1] === '*') {
        const closeIdx = sql.indexOf('*/', i + 2);
        if (closeIdx === -1 || closeIdx + 2 > lineEnd) break;
        i = closeIdx + 2;
        continue;
      }
      break;
    }
    if (
      lineEnd - i >= 10 &&
      (sql[i] === 'D' || sql[i] === 'd') &&
      sql.slice(i, i + 9).toUpperCase() === 'DELIMITER' &&
      (sql[i + 9] === ' ' || sql[i + 9] === '\t')
    ) {
      const rawToken = sql
        .slice(i + 10, lineEnd)
        .replace(/\r$/, '')
        .trim();
      if (rawToken.length > MAX_DELIMITER_LENGTH) {
        throw new ApiError(
          400,
          'INVALID_DELIMITER',
          `DELIMITER exceeds maximum allowed length of ${MAX_DELIMITER_LENGTH} characters`,
        );
      }
      for (let k = 0; k < rawToken.length; k += 1) {
        const code = rawToken.charCodeAt(k);
        if (code < 0x20 || code === 0x7f) {
          throw new ApiError(
            400,
            'INVALID_DELIMITER',
            'DELIMITER must not contain control characters',
          );
        }
      }
    }
    pos = lineEnd + 1;
  }
}

export function splitMariaDbStatements(sql: string): SplitStatement[] {
  // Strip UTF-8 BOM before splitting so dbgate-query-splitter does not treat it
  // as a data token on line 1 (which would break line-1 DELIMITER directives).
  const normalized = sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql;
  validateCustomDelimiters(normalized);
  const items = splitQuery(normalized, {
    ...mysqlSplitterOptions,
    returnRichInfo: true,
  }) as RichSplitItem[];

  const result: SplitStatement[] = [];
  for (const item of items) {
    const { sql: cleanedSql, skippedNewlines } = stripLeadingNonConditionalComments(item.text);
    if (!cleanedSql) continue;

    // Skip pure-comment chunks
    const stripped = stripCommentsAndLiterals(cleanedSql).trim();
    if (!stripped) continue;

    const startLine = item.trimStart.line + 1 + skippedNewlines;
    result.push({ sql: cleanedSql, startLine });
  }
  return result;
}

type DenylistRule =
  { pattern: RegExp; message: string } | { test: (cleaned: string) => boolean; message: string };

const DENYLIST_RULES: DenylistRule[] = [
  {
    pattern: /\bGRANT\b/i,
    message:
      'Not available in the playground: GRANT is disabled (workspace privileges are managed automatically).',
  },
  {
    pattern: /\bREVOKE\b/i,
    message:
      'Not available in the playground: REVOKE is disabled (workspace privileges are managed automatically).',
  },
  {
    pattern: /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?|DROP\s+|ALTER\s+|RENAME\s+)USER\b/i,
    message: 'Not available in the playground: user management statements are disabled.',
  },
  {
    pattern: /\bSET\s+(?:GLOBAL|PERSIST|PERSIST_ONLY)\b|@@(?:GLOBAL|PERSIST|PERSIST_ONLY)\./i,
    message:
      'Not available in the playground: modifying global server variables is disabled. Use SET SESSION instead.',
  },
  {
    pattern: /\bSET\s+PASSWORD\b/i,
    message: 'Not available in the playground: SET PASSWORD is disabled.',
  },
  {
    pattern: /\b(?:UN)?INSTALL\s+(?:PLUGIN|SONAME|COMPONENT)\b/i,
    message: 'Not available in the playground: plugin management is disabled.',
  },
  {
    test: (cleaned) =>
      /\bSONAME\b/i.test(cleaned) &&
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:AGGREGATE\s+)?FUNCTION\b/i.test(cleaned),
    message: 'Not available in the playground: native UDF loading (SONAME) is disabled.',
  },
  {
    pattern: /\bSHUTDOWN\b/i,
    message: 'Not available in the playground: SHUTDOWN is disabled.',
  },
  {
    pattern: /\bLOAD\s+(?:DATA|XML)\b/i,
    message: 'Not available in the playground: LOAD DATA / LOAD XML is disabled.',
  },
  {
    pattern: /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i,
    message:
      'Not available in the playground: writing server files via INTO OUTFILE / DUMPFILE is disabled.',
  },
  {
    pattern: /\bBENCHMARK\s*\(/i,
    message: 'Not available in the playground: BENCHMARK() is disabled.',
  },
  {
    pattern: /\b(?:PREPARE\s+\S+\s+FROM|EXECUTE\s+IMMEDIATE)\b/i,
    message:
      'Not available in the playground: dynamic SQL (PREPARE / EXECUTE IMMEDIATE) is disabled.',
  },
];

function checkCleanedDenylist(cleaned: string, workspaceDb: string): string | null {
  for (const rule of DENYLIST_RULES) {
    const matched = 'pattern' in rule ? rule.pattern.test(cleaned) : rule.test(cleaned);
    if (matched) {
      return rule.message;
    }
  }

  // Check USE <other_db>
  const useMatch = /^\s*USE\s+(`[^`]+`|[A-Za-z0-9_$]+)/i.exec(cleaned);
  if (useMatch) {
    const rawTarget = useMatch[1]!.replace(/^`|`$/g, '');
    if (rawTarget.toLowerCase() !== workspaceDb.toLowerCase()) {
      return `Not available in the playground: USE ${rawTarget} is blocked (workspaces are isolated to ${workspaceDb}).`;
    }
  }

  return null;
}

export function checkDenylist(sql: string, workspaceDb: string): string | null {
  const defaultHit = checkCleanedDenylist(stripCommentsAndLiterals(sql, true), workspaceDb);
  if (defaultHit) return defaultHit;

  // Also inspect under NO_BACKSLASH_ESCAPES semantics when backslashes are present
  if (sql.includes('\\')) {
    const noBsHit = checkCleanedDenylist(stripCommentsAndLiterals(sql, false), workspaceDb);
    if (noBsHit) return noBsHit;
  }

  return null;
}

// MariaDB / MySQL wire protocol field type codes (mysql2 Types)
const MYSQL_TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  14: 'DATE',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VARCHAR',
  254: 'CHAR',
  255: 'GEOMETRY',
};

const BINARY_CHARSET = 63;

export function formatColumnType(field: FieldPacket): string {
  const code = field.columnType ?? 253;
  const isBinary = field.characterSet === BINARY_CHARSET;

  if (code === 252) return isBinary ? 'BLOB' : 'TEXT';
  if (code === 249) return isBinary ? 'TINYBLOB' : 'TINYTEXT';
  if (code === 250) return isBinary ? 'MEDIUMBLOB' : 'MEDIUMTEXT';
  if (code === 251) return isBinary ? 'LONGBLOB' : 'LONGTEXT';
  if (code === 253) return isBinary ? 'VARBINARY' : 'VARCHAR';
  if (code === 254) return isBinary ? 'BINARY' : 'CHAR';

  return MYSQL_TYPE_NAMES[code] ?? `TYPE_${code}`;
}

function normalizeCellValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') {
    const asNum = Number(val);
    return Number.isSafeInteger(asNum) ? asNum : val.toString();
  }
  if (Buffer.isBuffer(val)) {
    return val.toString('utf8');
  }
  return val;
}

function isConnectionLostError(err: { code?: string; fatal?: boolean }): boolean {
  if (err.fatal) return true;
  return (
    err.code === 'PROTOCOL_CONNECTION_LOST' ||
    err.code === 'ECONNRESET' ||
    err.code === 'EPIPE' ||
    err.code === 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'
  );
}

interface WarningRow extends RowDataPacket {
  Level: string;
  Code: number;
  Message: string;
}

interface RawCallbackQuery extends EventEmitter {
  on(event: 'fields', listener: (fields: FieldPacket[] | undefined) => void): this;
  on(event: 'result', listener: (row: unknown[] | ResultSetHeader) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'end', listener: () => void): this;
}

interface RawCallbackConnection {
  query(options: { sql: string; rowsAsArray: true }): RawCallbackQuery;
}

function getRawCallbackConnection(
  conn: import('mysql2/promise').Connection,
): RawCallbackConnection | null {
  const raw = (conn as unknown as { connection?: RawCallbackConnection }).connection;
  return raw && typeof raw.query === 'function' ? raw : null;
}

interface StreamedQueryResult {
  kind: 'rows' | 'ok';
  columns?: ColumnMeta[];
  rows?: unknown[][];
  truncated?: boolean;
  bytesAdded: number;
  header?: ResultSetHeader;
  killedOnTruncate: boolean;
}

function executeStreamingQuery(
  rawConn: RawCallbackConnection,
  sql: string,
  rowCap: number,
  currentResponseBytes: number,
  responseCapBytes: number,
  onKillQuery: () => void,
): Promise<StreamedQueryResult> {
  return new Promise<StreamedQueryResult>((resolve, reject) => {
    const query = rawConn.query({ sql, rowsAsArray: true });
    let settled = false;
    let isRowSet = false;
    let columns: ColumnMeta[] = [];
    const rows: unknown[][] = [];
    let truncated = false;
    let droppedRows = 0;
    let bytesAdded = 0;
    let header: ResultSetHeader | undefined;
    let killRequested = false;

    const triggerKillOnce = (): void => {
      if (killRequested) return;
      killRequested = true;
      onKillQuery();
    };

    const finishOk = (): void => {
      if (settled) return;
      settled = true;
      if (isRowSet) {
        resolve({
          kind: 'rows',
          columns,
          rows,
          truncated,
          bytesAdded,
          killedOnTruncate: killRequested,
        });
      } else {
        resolve({
          kind: 'ok',
          header: header ?? ({ affectedRows: 0, warningStatus: 0 } as ResultSetHeader),
          bytesAdded: 0,
          killedOnTruncate: false,
        });
      }
    };

    query.on('fields', (fields) => {
      if (Array.isArray(fields)) {
        isRowSet = true;
        columns = fields.map((f) => ({
          name: f.name,
          type: formatColumnType(f),
        }));
      }
    });

    query.on('result', (rowOrHeader) => {
      if (!isRowSet) {
        header = rowOrHeader as ResultSetHeader;
        return;
      }
      if (truncated) {
        droppedRows += 1;
        if (droppedRows >= 8) {
          triggerKillOnce();
        }
        return;
      }
      if (rows.length >= rowCap) {
        truncated = true;
        droppedRows += 1;
        return;
      }
      const normalized = (rowOrHeader as unknown[]).map(normalizeCellValue);
      const rowBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
      if (currentResponseBytes + bytesAdded + rowBytes > responseCapBytes) {
        truncated = true;
        triggerKillOnce();
        return;
      }
      bytesAdded += rowBytes;
      rows.push(normalized);
    });

    query.on('error', (err) => {
      if (settled) return;
      const mysqlErr = err as { errno?: number };
      // If we triggered KILL QUERY because the response cap was exceeded,
      // ER_QUERY_INTERRUPTED (1317) is the expected termination of the truncated stream.
      if (killRequested && truncated && mysqlErr.errno === 1317) {
        finishOk();
        return;
      }
      settled = true;
      reject(err);
    });

    query.on('end', () => {
      finishOk();
    });
  });
}

export class ExecEngine {
  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly config: AppConfig,
  ) {}

  async execute(wsId: string, req: ExecRequest): Promise<ExecResponse> {
    const ws = this.workspaceManager.getWorkspace(wsId);
    this.workspaceManager.touchWorkspace(ws);

    const session = await this.workspaceManager.acquireSession(ws, req.session);
    let connectionBroken = false;
    let maxStmtTimeLowered = false;
    const results: StatementResult[] = [];
    let responseBytes = 0;

    try {
      const statements = splitMariaDbStatements(req.sql);
      if (statements.length > this.config.EXEC_MAX_STATEMENTS) {
        throw new ApiError(
          400,
          'TOO_MANY_STATEMENTS',
          `Batch contains ${statements.length} statements, exceeding the limit of ${this.config.EXEC_MAX_STATEMENTS}.`,
        );
      }

      const deadlineMs = Date.now() + this.config.EXEC_TIMEOUT_MS;

      for (let i = 0; i < statements.length; i += 1) {
        const stmt = statements[i]!;
        const t0 = process.hrtime.bigint();

        if (this.workspaceManager.isSessionAbortRequested(ws, req.session)) {
          results.push({
            index: i,
            sql: stmt.sql,
            startLine: stmt.startLine,
            kind: 'error',
            error: {
              code: 'ER_QUERY_INTERRUPTED',
              errno: 1317,
              message: 'Query execution was interrupted',
            },
            durationMs: 0,
          });
          break;
        }

        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          results.push({
            index: i,
            sql: stmt.sql,
            startLine: stmt.startLine,
            kind: 'error',
            error: {
              code: 'EXEC_TIMEOUT',
              message: `Execution exceeded wall-clock limit of ${Math.round(this.config.EXEC_TIMEOUT_MS / 1000)} s`,
            },
            durationMs: 0,
          });
          break;
        }

        const deniedMsg = checkDenylist(stmt.sql, ws.database);
        if (deniedMsg) {
          results.push({
            index: i,
            sql: stmt.sql,
            startLine: stmt.startLine,
            kind: 'error',
            error: {
              code: 'PLAYGROUND_DENIED',
              message: deniedMsg,
            },
            durationMs: Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000,
          });
          if (req.stopOnError) break;
          continue;
        }

        try {
          const remainingSec = remainingMs / 1000;
          if (remainingSec < 5) {
            const cappedSec = Math.max(0.1, Number(remainingSec.toFixed(3)));
            await session.conn.query(`SET SESSION max_statement_time = ${cappedSec}`);
            maxStmtTimeLowered = true;
          }
          const rawConn = getRawCallbackConnection(session.conn);
          if (rawConn) {
            const streamed = await executeStreamingQuery(
              rawConn,
              stmt.sql,
              this.config.ROW_CAP,
              responseBytes,
              this.config.RESPONSE_CAP_BYTES,
              () => {
                void this.workspaceManager.killSessionQuery(ws.wsId, req.session).catch(() => {});
              },
            );
            const durationMs =
              Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;

            if (streamed.kind === 'rows') {
              responseBytes += streamed.bytesAdded;
              const rows = streamed.rows ?? [];
              const warnings = streamed.killedOnTruncate
                ? []
                : await this.fetchWarnings(session.conn);
              const stmtRes: StatementResult = {
                index: i,
                sql: stmt.sql,
                startLine: stmt.startLine,
                kind: 'rows',
                columns: streamed.columns ?? [],
                rows,
                rowCount: rows.length,
                truncated: Boolean(streamed.truncated),
                durationMs,
              };
              if (warnings.length > 0) {
                stmtRes.warnings = warnings;
              }
              results.push(stmtRes);
            } else {
              const header = streamed.header!;
              const stmtRes: StatementResult = {
                index: i,
                sql: stmt.sql,
                startLine: stmt.startLine,
                kind: 'ok',
                affectedRows: header.affectedRows,
                durationMs,
              };
              if (header.insertId !== undefined && header.insertId !== 0) {
                stmtRes.insertId = header.insertId;
              }
              if (header.warningStatus > 0) {
                const warnings = await this.fetchWarnings(session.conn);
                if (warnings.length > 0) {
                  stmtRes.warnings = warnings;
                }
              }
              results.push(stmtRes);
            }
          } else {
            const [raw, fields] = await session.conn.query({
              sql: stmt.sql,
              rowsAsArray: true,
            });
            const durationMs =
              Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;

            if (Array.isArray(raw)) {
              const columns: ColumnMeta[] = (fields ?? []).map((f) => ({
                name: f.name,
                type: formatColumnType(f),
              }));

              const totalRows = raw.length;
              let truncated = totalRows > this.config.ROW_CAP;
              const limit = Math.min(totalRows, this.config.ROW_CAP);
              const rows: unknown[][] = [];

              for (let r = 0; r < limit; r += 1) {
                const row = (raw[r] as unknown[]).map(normalizeCellValue);
                const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
                if (responseBytes + rowBytes > this.config.RESPONSE_CAP_BYTES) {
                  truncated = true;
                  break;
                }
                responseBytes += rowBytes;
                rows.push(row);
              }

              const warnings = await this.fetchWarnings(session.conn);
              const stmtRes: StatementResult = {
                index: i,
                sql: stmt.sql,
                startLine: stmt.startLine,
                kind: 'rows',
                columns,
                rows,
                rowCount: rows.length,
                truncated,
                durationMs,
              };
              if (warnings.length > 0) {
                stmtRes.warnings = warnings;
              }
              results.push(stmtRes);
            } else {
              const header = raw as ResultSetHeader;
              const stmtRes: StatementResult = {
                index: i,
                sql: stmt.sql,
                startLine: stmt.startLine,
                kind: 'ok',
                affectedRows: header.affectedRows,
                durationMs,
              };
              if (header.insertId !== undefined && header.insertId !== 0) {
                stmtRes.insertId = header.insertId;
              }
              if (header.warningStatus > 0) {
                const warnings = await this.fetchWarnings(session.conn);
                if (warnings.length > 0) {
                  stmtRes.warnings = warnings;
                }
              }
              results.push(stmtRes);
            }
          }
        } catch (err) {
          const durationMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
          const mysqlErr = err as {
            code?: string;
            errno?: number;
            sqlState?: string;
            sqlMessage?: string;
            message?: string;
            fatal?: boolean;
          };

          if (isConnectionLostError(mysqlErr)) {
            connectionBroken = true;
          }

          results.push({
            index: i,
            sql: stmt.sql,
            startLine: stmt.startLine,
            kind: 'error',
            error: {
              code: mysqlErr.code ?? 'SQL_ERROR',
              errno: mysqlErr.errno,
              sqlState: mysqlErr.sqlState,
              message: mysqlErr.sqlMessage ?? mysqlErr.message ?? 'SQL execution error',
            },
            durationMs,
          });

          if (req.stopOnError || connectionBroken) {
            break;
          }
        }
      }

      let txOpen = false;
      if (!connectionBroken && !this.workspaceManager.isSessionAbortRequested(ws, req.session)) {
        try {
          const [txRows] = await session.conn.query<RowDataPacket[]>(
            'SELECT @@in_transaction AS in_tx',
          );
          txOpen = Number(txRows[0]?.in_tx ?? 0) === 1;
        } catch {
          connectionBroken = true;
        }
      }

      return { results, txOpen };
    } finally {
      if (
        maxStmtTimeLowered &&
        !connectionBroken &&
        !this.workspaceManager.isSessionAbortRequested(ws, req.session)
      ) {
        try {
          await session.conn.query('SET SESSION max_statement_time = 5');
        } catch {
          connectionBroken = true;
        }
      }
      this.workspaceManager.releaseSession(ws, req.session, session);
      if (connectionBroken) {
        if (ws.sessions[req.session] === session) {
          delete ws.sessions[req.session];
        }
        await session.conn.end().catch(() => {
          session.conn.destroy();
        });
      }
    }
  }

  private async fetchWarnings(
    conn: import('mysql2/promise').Connection,
  ): Promise<StatementWarning[]> {
    try {
      const [rows] = await conn.query<WarningRow[]>('SHOW WARNINGS');
      return rows.map((r) => ({
        level: r.Level,
        code: Number(r.Code),
        message: r.Message,
      }));
    } catch {
      return [];
    }
  }
}
