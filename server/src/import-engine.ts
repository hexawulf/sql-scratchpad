import type { EventEmitter } from 'node:events';
import type { Connection, FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type {
  ImportErrorDetail,
  ImportRequest,
  ImportResponse,
  ImportRewrittenStatement,
  ImportSkippedStatement,
} from '@sql-scratchpad/shared';
import type { AppConfig } from './config.js';
import { ApiError } from './errors.js';
import { checkDenylist, splitMariaDbStatements, stripCommentsAndLiterals } from './exec-engine.js';
import type { WorkspaceManager } from './workspace-manager.js';

const MAX_REPORTED_ITEMS = 100;
const BATCH_COMMIT_INTERVAL = 1000;

export class ImportByteBudget {
  private readonly usage = new Map<string, Array<{ ts: number; bytes: number }>>();

  constructor(
    private readonly maxBytesPerWindow: number,
    private readonly windowMs: number = 60 * 60 * 1000,
  ) {}

  consume(
    key: string,
    bytes: number,
    now: number = Date.now(),
  ): { allowed: true; remainingBytes: number } | { allowed: false; retryAfterSec: number } {
    const cutoff = now - this.windowMs;
    const existing = this.usage.get(key) ?? [];
    const active = existing.filter((e) => e.ts > cutoff);

    let used = 0;
    for (const entry of active) {
      used += entry.bytes;
    }

    if (used + bytes > this.maxBytesPerWindow) {
      if (active.length === 0) {
        this.usage.delete(key);
      } else {
        this.usage.set(key, active);
      }
      // Find earliest timestamp whose expiry frees enough room for `bytes`
      let freed = 0;
      const needed = used + bytes - this.maxBytesPerWindow;
      let retryAfterMs = this.windowMs;
      for (const entry of active) {
        freed += entry.bytes;
        if (freed >= needed) {
          retryAfterMs = Math.max(1000, entry.ts + this.windowMs - now);
          break;
        }
      }
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    active.push({ ts: now, bytes });
    this.usage.set(key, active);
    return {
      allowed: true,
      remainingBytes: Math.max(0, this.maxBytesPerWindow - (used + bytes)),
    };
  }
}

/**
 * Strip leading whitespace and non-conditional comments (--, #, /* ... *\/)
 * while preserving executable conditional comments (/*! ... *\/).
 */
function stripLeadingComments(sql: string): string {
  let i = 0;
  const n = sql.length;

  while (i < n) {
    while (i < n && /\s/.test(sql[i]!)) i += 1;
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
        i += 1;
      }
      i += 2;
      continue;
    }

    break;
  }

  return sql.slice(i).trim();
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === '\\' && i + 1 < input.length) {
        i += 1;
        continue;
      }
      if (ch === quote) {
        if (input[i + 1] === quote) {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

const SKIPPABLE_CONDITIONAL_VAR_RE =
  /^(?:CHARACTER_SET_[A-Z0-9_]+|COLLATION_[A-Z0-9_]+|SQL_MODE|TIME_ZONE|FOREIGN_KEY_CHECKS|UNIQUE_CHECKS|SQL_NOTES|OLD_[A-Z0-9_]+)$/i;

function isSkippableConditionalSet(innerSql: string): boolean {
  if (/^SET\s+NAMES\b/i.test(innerSql)) {
    return true;
  }
  const setMatch = /^SET\s+([\s\S]+)$/i.exec(innerSql);
  if (!setMatch) return false;

  const assignments = splitTopLevelCommas(setMatch[1]!);
  if (assignments.length === 0) return false;

  for (const part of assignments) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) return false;
    const rawLhs = part.slice(0, eqIdx).trim();
    // Never treat GLOBAL / PERSIST as a harmless session charset SET here
    if (/^(?:GLOBAL|PERSIST|PERSIST_ONLY)\b|^@@(?:GLOBAL|PERSIST|PERSIST_ONLY)\./i.test(rawLhs)) {
      return false;
    }
    const normalized = rawLhs
      .replace(/^(?:SESSION|LOCAL)\s+/i, '')
      .replace(/^@@(?:SESSION|LOCAL)\./i, '')
      .replace(/^@@/, '')
      .replace(/^@/, '')
      .replace(/^`|`$/g, '')
      .trim();

    if (!SKIPPABLE_CONDITIONAL_VAR_RE.test(normalized)) {
      return false;
    }
  }
  return true;
}

/**
 * Classify statements that cannot run inside a workspace (or are dump artefacts)
 * and should be skipped and reported in the import summary rather than failing.
 *
 * Conditional comments (`/*!NNNNN ... *\/`) are skipped ONLY when the inner
 * statement is a SET of session/charset variables (NAMES, CHARACTER_SET_*,
 * COLLATION_*, SQL_MODE, TIME_ZONE, FOREIGN_KEY_CHECKS, UNIQUE_CHECKS,
 * SQL_NOTES, OLD_*) or ALTER TABLE ... DISABLE/ENABLE KEYS. Every other
 * conditional comment (e.g. /*!50001 CREATE ... VIEW *\/, /*!50003 CREATE TRIGGER *\/)
 * executes as normal SQL.
 */
function stripTrailingSemicolonsAndWhitespace(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === ';' || /\s/.test(s[end - 1]!))) {
    end -= 1;
  }
  return s.slice(0, end);
}

function extractSingleConditionalCommentBody(s: string): string | null {
  const isMaria = s.startsWith('/*M!');
  if ((!isMaria && !s.startsWith('/*!')) || !s.endsWith('*/')) {
    return null;
  }
  let i = isMaria ? 4 : 3;
  const bodyEnd = s.length - 2;
  while (i < bodyEnd && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) {
    i += 1;
  }
  const wsStart = i;
  while (i < bodyEnd && /\s/.test(s[i]!)) {
    i += 1;
  }
  if (i === wsStart || i >= bodyEnd) return null;
  const body = s.slice(i, bodyEnd);
  if (body.includes('*/')) return null;
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function classifyImportSkip(sql: string): string | null {
  const leadStripped = stripTrailingSemicolonsAndWhitespace(stripLeadingComments(sql));

  // Check single conditional-comment statement: /*!NNNNN <inner> */ or /*M!NNNNN <inner> */
  const inner = extractSingleConditionalCommentBody(leadStripped);
  if (inner !== null) {
    if (/^ALTER\s+TABLE\s/i.test(inner) && /\b(?:DISABLE|ENABLE)\s+KEYS\b/i.test(inner)) {
      return 'Dump ALTER TABLE DISABLE/ENABLE KEYS header skipped';
    }
    if (isSkippableConditionalSet(inner)) {
      return 'Dump session/charset SET header skipped';
    }
  }

  const cleaned = stripCommentsAndLiterals(sql).trim();

  if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:DATABASE|SCHEMA)\b/i.test(cleaned)) {
    return 'CREATE DATABASE is not applicable in a workspace';
  }
  if (/^DROP\s+(?:DATABASE|SCHEMA)\b/i.test(cleaned)) {
    return 'DROP DATABASE is not applicable in a workspace';
  }
  if (/^USE\b/i.test(cleaned)) {
    return 'USE <database> skipped (imports run in the active workspace)';
  }
  if (/^SET\s+(?:GLOBAL|PERSIST|PERSIST_ONLY)\b|^SET\s+@@GLOBAL\./i.test(cleaned)) {
    return 'SET GLOBAL is not permitted in a workspace';
  }
  if (/^(?:LOCK|UNLOCK)\s+TABLES?\b/i.test(cleaned)) {
    return 'LOCK/UNLOCK TABLES dump statement skipped';
  }

  return null;
}

const QUOTED_OR_IDENT =
  `(?:` + '`(?:[^`]|``)*`' + `|'(?:[^']|'')*'` + `|"(?:[^"]|"")*"` + `|[A-Za-z0-9_.%$-]+)`;

const CONDITIONAL_DEFINER_RE = new RegExp(
  `\\/\\*!\\d*\\s+DEFINER\\s*=\\s*(?:CURRENT_USER(?:\\s*\\(\\s*\\))?|${QUOTED_OR_IDENT}\\s*@\\s*${QUOTED_OR_IDENT})\\s*\\*\\/\\s*`,
  'gi',
);

const BARE_DEFINER_RE = new RegExp(
  `\\bDEFINER\\s*=\\s*(?:CURRENT_USER(?:\\s*\\(\\s*\\))?|${QUOTED_OR_IDENT}\\s*@\\s*${QUOTED_OR_IDENT})\\s*`,
  'gi',
);

const SQL_SECURITY_DEFINER_RE = /\bSQL\s+SECURITY\s+DEFINER\b\s*/gi;

function isDefinerBearingCreate(sql: string): boolean {
  const cleaned = stripCommentsAndLiterals(sql).trim();
  if (!/^CREATE\b/i.test(cleaned)) return false;
  // Exclude CREATE [TEMPORARY] TABLE / INDEX / DATABASE / SCHEMA / USER
  if (
    /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMPORARY\s+)?(?:TABLE|DATABASE|SCHEMA|USER|(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }
  return /\b(?:VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT)\b/i.test(cleaned);
}

/**
 * Strip `DEFINER=<user>@<host>` (any quoting, including conditional-comment wrapped)
 * and `SQL SECURITY DEFINER` from CREATE VIEW/TRIGGER/PROCEDURE/FUNCTION/EVENT
 * statements before executing as the workspace user.
 */
export function rewriteDefinerClauses(sql: string): { sql: string; reason: string | null } {
  if (!isDefinerBearingCreate(sql)) {
    return { sql, reason: null };
  }

  const reasons: string[] = [];
  let rewritten = sql;

  const afterCondDefiner = rewritten.replace(CONDITIONAL_DEFINER_RE, '');
  if (afterCondDefiner !== rewritten) {
    rewritten = afterCondDefiner;
    reasons.push('Stripped DEFINER clause');
  }

  const afterBareDefiner = rewritten.replace(BARE_DEFINER_RE, '');
  if (afterBareDefiner !== rewritten) {
    rewritten = afterBareDefiner;
    if (!reasons.includes('Stripped DEFINER clause')) {
      reasons.push('Stripped DEFINER clause');
    }
  }

  const afterSecurity = rewritten.replace(SQL_SECURITY_DEFINER_RE, '');
  if (afterSecurity !== rewritten) {
    rewritten = afterSecurity;
    reasons.push('Stripped SQL SECURITY DEFINER');
  }

  if (reasons.length === 0) {
    return { sql, reason: null };
  }

  return { sql: rewritten, reason: reasons.join('; ') };
}

function makeSnippet(sql: string): string {
  const flat = stripLeadingComments(sql).replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

export function buildImportErrorHint(
  errno: number | undefined,
  dataset: string,
  alreadyApplied: boolean,
): string | undefined {
  if (errno !== 1146) return undefined;
  if (!alreadyApplied) {
    return `Current dataset is '${dataset}'. This script references a table that doesn't exist — it may be a query script. Open it in an editor tab instead, or import the schema script first.`;
  }
  return `Current dataset is '${dataset}'. This statement references a table that doesn't exist — check that the schema was imported in the right order or select the expected dataset first.`;
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

interface TableNameRow extends RowDataPacket {
  TABLE_NAME: string;
}

interface SessionTxStateRow extends RowDataPacket {
  in_tx: number | string;
  auto_c: number | string;
}

interface RawImportQuery extends EventEmitter {
  on(event: 'fields', listener: (fields: FieldPacket[] | undefined) => void): this;
  on(event: 'result', listener: (row: unknown[] | ResultSetHeader) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'end', listener: () => void): this;
}

interface RawImportConnection {
  query(options: { sql: string; rowsAsArray: true }): RawImportQuery;
}

function estimateRowBytes(row: unknown[]): number {
  let total = 16;
  for (const cell of row) {
    if (typeof cell === 'string') total += cell.length;
    else if (Buffer.isBuffer(cell)) total += cell.length;
    else if (cell !== null && cell !== undefined) total += 8;
  }
  return total;
}

function executeImportStatementStreaming(
  conn: Connection,
  sql: string,
  maxDiscardedBytes: number,
  onOverflowKill: () => void,
): Promise<{ warningStatus: number }> {
  const rawConn = (conn as unknown as { connection?: RawImportConnection }).connection;
  if (!rawConn || typeof rawConn.query !== 'function') {
    return conn.query({ sql, rowsAsArray: true }).then(([raw]) => {
      if (!Array.isArray(raw)) {
        return { warningStatus: Number((raw as ResultSetHeader).warningStatus ?? 0) };
      }
      return { warningStatus: 0 };
    });
  }

  return new Promise<{ warningStatus: number }>((resolve, reject) => {
    const query = rawConn.query({ sql, rowsAsArray: true });
    let settled = false;
    let isRowSet = false;
    let warningStatus = 0;
    let discardedBytes = 0;
    let killRequested = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve({ warningStatus });
    };

    query.on('fields', (fields) => {
      if (Array.isArray(fields)) {
        isRowSet = true;
      }
    });

    query.on('result', (rowOrHeader) => {
      if (!isRowSet) {
        warningStatus = Number((rowOrHeader as ResultSetHeader).warningStatus ?? 0);
        return;
      }
      // Stream and discard result rows immediately so /import never buffers result sets in heap
      discardedBytes += estimateRowBytes(rowOrHeader as unknown[]);
      if (!killRequested && discardedBytes > maxDiscardedBytes) {
        killRequested = true;
        onOverflowKill();
      }
    });

    query.on('error', (err) => {
      if (settled) return;
      const mysqlErr = err as { errno?: number };
      if (killRequested && mysqlErr.errno === 1317) {
        finish();
        return;
      }
      settled = true;
      reject(err);
    });

    query.on('end', () => {
      finish();
    });
  });
}

async function listWorkspaceTables(conn: Connection): Promise<string[]> {
  const [rows] = await conn.query<TableNameRow[]>(
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
  );
  return rows.map((r) => r.TABLE_NAME);
}

export class ImportEngine {
  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly config: AppConfig,
  ) {}

  async importSql(wsId: string, req: ImportRequest): Promise<ImportResponse> {
    const tStart = process.hrtime.bigint();

    // Validate workspace existence before splitting
    let ws = this.workspaceManager.getWorkspace(wsId);
    this.workspaceManager.touchWorkspace(ws);

    // Split with DELIMITER support and enforce statement cap before mutating workspace
    const statements = splitMariaDbStatements(req.sql);
    if (statements.length > this.config.IMPORT_MAX_STATEMENTS) {
      throw new ApiError(
        400,
        'TOO_MANY_STATEMENTS',
        `Import contains ${statements.length} statements, exceeding the limit of ${this.config.IMPORT_MAX_STATEMENTS}.`,
      );
    }

    if (req.mode === 'fresh') {
      await this.workspaceManager.resetWorkspace(wsId, 'empty');
      ws = this.workspaceManager.getWorkspace(wsId);
    }

    // Always run on the workspace's own user & connection — never adminPool
    const session = await this.workspaceManager.acquireSession(ws, 'A');
    let connectionBroken = false;
    let batchedAutocommit = false;
    let prevAutocommit = 1;
    let restoreAutocommit = false;

    const skipped: ImportSkippedStatement[] = [];
    let skippedCount = 0;
    let skippedTruncated = false;

    const rewritten: ImportRewrittenStatement[] = [];
    let rewrittenCount = 0;
    let rewrittenTruncated = false;

    let statementsRun = 0;
    let statementsOk = 0;
    let warningsCount = 0;
    let importError: ImportErrorDetail | undefined;

    try {
      // Read session transaction and autocommit state BEFORE running anything
      const [stateRows] = await session.conn.query<SessionTxStateRow[]>(
        'SELECT @@in_transaction AS in_tx, @@autocommit AS auto_c',
      );
      const inTx = Number(stateRows[0]?.in_tx ?? 0) === 1;
      prevAutocommit = Number(stateRows[0]?.auto_c ?? 1) === 1 ? 1 : 0;

      if (req.mode === 'append' && inTx) {
        throw new ApiError(
          409,
          'TRANSACTION_OPEN',
          'Transaction open in session A — COMMIT or ROLLBACK first',
        );
      }
      restoreAutocommit = true;

      const beforeTables = req.mode === 'fresh' ? [] : await listWorkspaceTables(session.conn);
      const beforeSet = new Set(beforeTables);

      // Batch InnoDB commits for large scripts without explicit ROLLBACK so 20k+ statements
      // complete well within the 75 s wall-clock cap while preserving partial-apply semantics.
      const hasExplicitRollback = statements.some((s) =>
        /\bROLLBACK\b/i.test(stripCommentsAndLiterals(s.sql)),
      );
      if (!hasExplicitRollback && statements.length > 50) {
        await session.conn.query('SET autocommit = 0');
        batchedAutocommit = true;
      }

      const deadlineMs = Date.now() + this.config.IMPORT_TIMEOUT_MS;
      let uncommittedOps = 0;

      for (let i = 0; i < statements.length; i += 1) {
        const stmt = statements[i]!;

        if (this.workspaceManager.isSessionAbortRequested(ws, 'A')) {
          importError = {
            index: i,
            startLine: stmt.startLine,
            code: 'QUERY_INTERRUPTED',
            errno: 1317,
            message: 'Import interrupted because the workspace was reset or deleted',
            alreadyApplied: statementsOk > 0,
          };
          break;
        }

        if (Date.now() >= deadlineMs) {
          importError = {
            index: i,
            startLine: stmt.startLine,
            code: 'IMPORT_TIMEOUT',
            message: `Import exceeded wall-clock limit of ${Math.round(this.config.IMPORT_TIMEOUT_MS / 1000)} s`,
            alreadyApplied: statementsOk > 0,
          };
          break;
        }

        const skipReason = classifyImportSkip(stmt.sql);
        if (skipReason) {
          skippedCount += 1;
          if (skipped.length < MAX_REPORTED_ITEMS) {
            skipped.push({
              index: i,
              startLine: stmt.startLine,
              reason: skipReason,
              snippet: makeSnippet(stmt.sql),
            });
          } else {
            skippedTruncated = true;
          }
          continue;
        }

        const { sql: execSql, reason: rewriteReason } = rewriteDefinerClauses(stmt.sql);
        if (rewriteReason) {
          rewrittenCount += 1;
          if (rewritten.length < MAX_REPORTED_ITEMS) {
            rewritten.push({
              index: i,
              startLine: stmt.startLine,
              reason: rewriteReason,
              snippet: makeSnippet(stmt.sql),
            });
          } else {
            rewrittenTruncated = true;
          }
        }

        const deniedMsg = checkDenylist(execSql, ws.database);
        if (deniedMsg) {
          statementsRun += 1;
          importError = {
            index: i,
            startLine: stmt.startLine,
            code: 'PLAYGROUND_DENIED',
            message: deniedMsg,
            alreadyApplied: statementsOk > 0,
          };
          break;
        }

        statementsRun += 1;
        try {
          const res = await executeImportStatementStreaming(
            session.conn,
            execSql,
            this.config.RESPONSE_CAP_BYTES,
            () => {
              void this.workspaceManager.killSessionQuery(ws.wsId, 'A').catch(() => {});
            },
          );
          warningsCount += res.warningStatus;
          statementsOk += 1;

          if (batchedAutocommit) {
            uncommittedOps += 1;
            if (uncommittedOps >= BATCH_COMMIT_INTERVAL) {
              await session.conn.query('COMMIT');
              uncommittedOps = 0;
            }
          }
        } catch (err) {
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

          const alreadyApplied = statementsOk > 0;
          const hint = buildImportErrorHint(mysqlErr.errno, ws.dataset, alreadyApplied);
          importError = {
            index: i,
            startLine: stmt.startLine,
            code: mysqlErr.code ?? 'SQL_ERROR',
            errno: mysqlErr.errno,
            sqlState: mysqlErr.sqlState,
            message: mysqlErr.sqlMessage ?? mysqlErr.message ?? 'SQL import error',
            alreadyApplied,
            ...(hint ? { hint } : {}),
          };
          break;
        }
      }

      const aborting = this.workspaceManager.isSessionAbortRequested(ws, 'A');
      if (batchedAutocommit && !connectionBroken && !aborting) {
        try {
          await session.conn.query('COMMIT');
        } catch {
          connectionBroken = true;
        }
      }

      let tablesCreated: string[] = [];
      if (!connectionBroken && !aborting) {
        try {
          const afterTables = await listWorkspaceTables(session.conn);
          tablesCreated = afterTables.filter((t) => !beforeSet.has(t));
        } catch {
          // Best-effort table summary if connection degraded
        }
      }

      const durationMs = Math.round((Number(process.hrtime.bigint() - tStart) / 1e6) * 1000) / 1000;

      const note = importError
        ? importError.alreadyApplied
          ? `Stopped at statement #${importError.index + 1} (line ${importError.startLine}). ${statementsOk} earlier statement(s) remain applied in the workspace.`
          : `Stopped at statement #${importError.index + 1} (line ${importError.startLine}). No earlier statements were applied.`
        : undefined;

      return {
        ok: !importError,
        mode: req.mode,
        totalStatements: statements.length,
        statementsRun,
        statementsOk,
        skippedCount,
        skipped,
        ...(skippedTruncated ? { skippedTruncated: true } : {}),
        rewrittenCount,
        rewritten,
        ...(rewrittenTruncated ? { rewrittenTruncated: true } : {}),
        warningsCount,
        durationMs,
        tablesCreated,
        ...(importError ? { error: importError } : {}),
        ...(note ? { note } : {}),
      };
    } finally {
      if (
        restoreAutocommit &&
        !connectionBroken &&
        !this.workspaceManager.isSessionAbortRequested(ws, 'A')
      ) {
        try {
          await session.conn.query(`SET autocommit = ${prevAutocommit}`);
        } catch {
          connectionBroken = true;
        }
      }
      this.workspaceManager.releaseSession(ws, 'A', session);
      this.workspaceManager.touchWorkspace(ws);
      if (connectionBroken) {
        if (ws.sessions.A === session) {
          delete ws.sessions.A;
        }
        await session.conn.end().catch(() => {
          session.conn.destroy();
        });
      }
    }
  }
}
