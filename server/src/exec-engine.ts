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
export function stripCommentsAndLiterals(sql: string): string {
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

    // Block comment /* ... */ (keep executable /*! ... */ content inspectable)
    if (ch === '/' && next === '*') {
      if (i + 2 < n && sql[i + 2] === '!') {
        // MariaDB conditional comment: inspect inner tokens
        i += 3;
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

    // Single-quoted or double-quoted string literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
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

export function splitMariaDbStatements(sql: string): SplitStatement[] {
  const items = splitQuery(sql, {
    ...mysqlSplitterOptions,
    returnRichInfo: true,
  }) as RichSplitItem[];

  const result: SplitStatement[] = [];
  for (const item of items) {
    const trimmed = item.text.trim();
    if (!trimmed) continue;

    // Skip pure-comment chunks
    const stripped = stripCommentsAndLiterals(trimmed).trim();
    if (!stripped) continue;

    // Advance startLine past leading comment-only lines inside the chunk
    let startLine = item.trimStart.line + 1;
    const lines = item.text.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t === '' || t.startsWith('--') || t.startsWith('#')) {
        startLine += 1;
      } else {
        break;
      }
    }

    result.push({ sql: trimmed, startLine });
  }
  return result;
}

const DENYLIST_RULES: Array<{ pattern: RegExp; message: string }> = [
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
    pattern: /\bSET\s+(?:GLOBAL|PERSIST|PERSIST_ONLY)\b|@@GLOBAL\./i,
    message:
      'Not available in the playground: modifying global server variables is disabled. Use SET SESSION instead.',
  },
  {
    pattern: /\b(?:UN)?INSTALL\s+(?:PLUGIN|SONAME|COMPONENT)\b/i,
    message: 'Not available in the playground: plugin management is disabled.',
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
];

export function checkDenylist(sql: string, workspaceDb: string): string | null {
  const cleaned = stripCommentsAndLiterals(sql);

  for (const rule of DENYLIST_RULES) {
    if (rule.pattern.test(cleaned)) {
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

export class ExecEngine {
  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly config: AppConfig,
  ) {}

  async execute(wsId: string, req: ExecRequest): Promise<ExecResponse> {
    const ws = this.workspaceManager.getWorkspace(wsId);
    this.workspaceManager.touchWorkspace(ws);

    const session = await this.workspaceManager.getOrCreateSession(ws, req.session);
    if (session.busy) {
      throw new ApiError(
        409,
        'SESSION_BUSY',
        `Session ${req.session} is already executing a statement`,
      );
    }

    session.busy = true;
    let connectionBroken = false;
    const results: StatementResult[] = [];
    let responseBytes = 0;

    try {
      const statements = splitMariaDbStatements(req.sql);

      for (let i = 0; i < statements.length; i += 1) {
        const stmt = statements[i]!;
        const t0 = process.hrtime.bigint();

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
        } catch (err) {
          const durationMs =
            Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
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
      if (!connectionBroken) {
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
      session.busy = false;
      session.lastUsedAt = Date.now();
      if (connectionBroken) {
        delete ws.sessions[req.session];
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
