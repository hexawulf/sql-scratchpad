import { randomBytes } from 'node:crypto';
import mysql, {
  type Connection,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise';
import type { FastifyBaseLogger } from 'fastify';
import type { DatasetMeta, SessionId } from '@sql-scratchpad/shared';
import type { AppConfig } from './config.js';
import { ApiError } from './errors.js';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function randomBase32Id(byteLength = 16): string {
  const bytes = randomBytes(byteLength);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function randomWorkspaceDbName(): string {
  return `ws_${randomBytes(6).toString('hex')}`;
}

export function templateDbName(datasetId: string): string {
  return `tpl_${datasetId.replace(/-/g, '_')}`;
}

export function escapeIdent(ident: string): string {
  return `\`${ident.replace(/`/g, '``')}\``;
}

export function escapeGrantDbIdent(dbName: string): string {
  // In MariaDB GRANT ON db.*, '_' and '%' are wildcards unless escaped.
  const escaped = dbName.replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/%/g, '\\%');
  return escapeIdent(escaped);
}

export function topoSortTables(
  tables: string[],
  fkEdges: Array<{ table: string; refTable: string }>,
): string[] {
  const tableSet = new Set(tables);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    deps.set(t, new Set());
  }
  for (const edge of fkEdges) {
    if (edge.table === edge.refTable) continue;
    if (!tableSet.has(edge.table) || !tableSet.has(edge.refTable)) continue;
    deps.get(edge.table)!.add(edge.refTable);
  }

  const ordered: string[] = [];
  const remaining = new Set(tables);

  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const t of remaining) {
      const d = deps.get(t)!;
      let allSatisfied = true;
      for (const parent of d) {
        if (remaining.has(parent)) {
          allSatisfied = false;
          break;
        }
      }
      if (allSatisfied) ready.push(t);
    }

    if (ready.length === 0) {
      // Break FK cycle deterministically
      const next = [...remaining].sort()[0]!;
      ordered.push(next);
      remaining.delete(next);
    } else {
      ready.sort();
      for (const t of ready) {
        ordered.push(t);
        remaining.delete(t);
      }
    }
  }

  return ordered;
}

export interface PinnedSession {
  id: SessionId;
  conn: Connection;
  threadId: number;
  busy: boolean;
  lastUsedAt: number;
}

export interface WorkspaceEntry {
  wsId: string;
  database: string;
  dbUser: string;
  password: string;
  dataset: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  ownerIpHash?: string;
  sessions: Partial<Record<SessionId, PinnedSession>>;
  sessionLocks: Partial<Record<SessionId, boolean>>;
  sessionWaiters: Partial<Record<SessionId, Array<() => void>>>;
  sessionAbort: Partial<Record<SessionId, boolean>>;
  teardownActive: boolean;
  deleting: boolean;
}

const DEFAULT_TEARDOWN_TIMEOUT_MS = 10_000;

interface TableNameRow extends RowDataPacket {
  TABLE_NAME: string;
}

interface FkEdgeRow extends RowDataPacket {
  TABLE_NAME: string;
  REFERENCED_TABLE_NAME: string;
}

interface ViewNameRow extends RowDataPacket {
  TABLE_NAME: string;
}

interface TriggerNameRow extends RowDataPacket {
  TRIGGER_NAME: string;
}

interface SchemaNameRow extends RowDataPacket {
  SCHEMA_NAME: string;
}

interface UserHostRow extends RowDataPacket {
  User: string;
  Host: string;
}

interface SchemaSizeRow extends RowDataPacket {
  table_schema: string;
  bytes: string | number;
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, WorkspaceEntry>();
  private readonly pendingByOwner = new Map<string, number>();
  private pendingTotal = 0;
  private readonly datasetMap: Map<string, DatasetMeta>;
  private janitorTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly adminPool: Pool,
    private readonly config: AppConfig,
    datasets: DatasetMeta[],
    private readonly logger: FastifyBaseLogger,
  ) {
    this.datasetMap = new Map(datasets.map((d) => [d.id, d]));
  }

  getWorkspaceCount(): number {
    return this.workspaces.size;
  }

  getWorkspace(wsId: string): WorkspaceEntry {
    const ws = this.workspaces.get(wsId);
    if (!ws || ws.deleting) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found or expired');
    }
    const now = Date.now();
    if (now >= ws.expiresAt || now >= ws.absoluteExpiresAt) {
      if (!this.isWorkspaceBusy(ws)) {
        void this.deleteWorkspace(wsId).catch(() => {});
      }
      throw new ApiError(404, 'WORKSPACE_EXPIRED', 'Workspace expired');
    }
    return ws;
  }

  isSessionBusy(ws: WorkspaceEntry, sid: SessionId): boolean {
    return Boolean(ws.sessionLocks[sid] || ws.sessions[sid]?.busy);
  }

  isWorkspaceBusy(ws: WorkspaceEntry): boolean {
    return Boolean(
      ws.teardownActive ||
      ws.deleting ||
      this.isSessionBusy(ws, 'A') ||
      this.isSessionBusy(ws, 'B'),
    );
  }

  isSessionAbortRequested(ws: WorkspaceEntry, sid: SessionId): boolean {
    return Boolean(ws.sessionAbort[sid] || ws.deleting);
  }

  touchWorkspace(ws: WorkspaceEntry): void {
    const now = Date.now();
    ws.lastActiveAt = now;
    ws.expiresAt = Math.min(now + this.config.WORKSPACE_TTL_MS, ws.absoluteExpiresAt);
  }

  private assertValidDataset(datasetId: string): DatasetMeta {
    const ds = this.datasetMap.get(datasetId);
    if (!ds) {
      throw new ApiError(400, 'UNKNOWN_DATASET', `Unknown dataset: ${datasetId}`);
    }
    if (!ds.engines.includes('mariadb')) {
      throw new ApiError(
        400,
        'UNSUPPORTED_ENGINE',
        `Dataset ${datasetId} is not available on MariaDB`,
      );
    }
    return ds;
  }

  async createWorkspace(
    datasetId: string,
    ownerIpHash?: string,
    bypassPerIpLimit = false,
  ): Promise<{
    wsId: string;
    database: string;
    expiresAt: string;
  }> {
    this.assertValidDataset(datasetId);

    const now = Date.now();

    // Evict any already-expired workspaces lazily before checking caps (skip busy ones)
    for (const [expiredId, existing] of [...this.workspaces.entries()]) {
      if (now >= existing.expiresAt || now >= existing.absoluteExpiresAt) {
        if (this.isWorkspaceBusy(existing)) continue;
        await this.deleteWorkspace(expiredId).catch(() => {});
      }
    }

    const checkNow = Date.now();
    if (ownerIpHash && !bypassPerIpLimit) {
      let ownedCount = this.pendingByOwner.get(ownerIpHash) ?? 0;
      let earliestExpiresAt = Infinity;
      for (const existing of this.workspaces.values()) {
        if (existing.ownerIpHash === ownerIpHash) {
          ownedCount += 1;
          if (existing.expiresAt < earliestExpiresAt) {
            earliestExpiresAt = existing.expiresAt;
          }
        }
      }
      if (ownedCount >= this.config.MAX_WORKSPACES_PER_IP) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil(
            (Math.min(earliestExpiresAt, checkNow + this.config.WORKSPACE_TTL_MS) - checkNow) /
              1000,
          ),
        );
        throw new ApiError(
          429,
          'PER_IP_WORKSPACE_LIMIT',
          `You have reached the maximum of ${this.config.MAX_WORKSPACES_PER_IP} active workspaces per IP. Close a workspace or wait for it to expire.`,
          retryAfterSec,
        );
      }
    }

    if (this.workspaces.size + this.pendingTotal >= this.config.MAX_WORKSPACES) {
      throw new ApiError(
        503,
        'WORKSPACE_LIMIT_REACHED',
        'SQL Scratchpad is busy, try again in a few minutes',
      );
    }

    // Reserve capacity synchronously before any async DB round-trips to prevent TOCTOU races
    this.pendingTotal += 1;
    if (ownerIpHash) {
      this.pendingByOwner.set(ownerIpHash, (this.pendingByOwner.get(ownerIpHash) ?? 0) + 1);
    }

    try {
      const totalBytes = await this.getTotalWorkspaceBytes();
      if (totalBytes >= this.config.MAX_TOTAL_WORKSPACE_BYTES) {
        throw new ApiError(
          503,
          'STORAGE_BUDGET_EXCEEDED',
          'Total workspace storage budget exceeded',
        );
      }

      const wsId = randomBase32Id(16);
      const database = randomWorkspaceDbName();
      const dbUser = database;
      const password = randomBytes(32).toString('base64url');

      try {
        await this.provisionDbAndUser(database, dbUser, password);
        if (datasetId !== 'empty') {
          await this.cloneTemplate(templateDbName(datasetId), database, dbUser, password);
        }
      } catch (err) {
        await this.dropDbAndUser(database, dbUser).catch((cleanupErr) => {
          this.logger.warn({ err: cleanupErr, database }, 'Failed to clean up partial workspace');
        });
        throw err;
      }

      const createdAt = Date.now();
      const absoluteExpiresAt = createdAt + this.config.WORKSPACE_MAX_TTL_MS;
      const entry: WorkspaceEntry = {
        wsId,
        database,
        dbUser,
        password,
        dataset: datasetId,
        createdAt,
        lastActiveAt: createdAt,
        expiresAt: Math.min(createdAt + this.config.WORKSPACE_TTL_MS, absoluteExpiresAt),
        absoluteExpiresAt,
        ownerIpHash,
        sessions: {},
        sessionLocks: {},
        sessionWaiters: {},
        sessionAbort: {},
        teardownActive: false,
        deleting: false,
      };
      this.workspaces.set(wsId, entry);

      return {
        wsId,
        database,
        expiresAt: new Date(entry.expiresAt).toISOString(),
      };
    } finally {
      this.pendingTotal = Math.max(0, this.pendingTotal - 1);
      if (ownerIpHash) {
        const cur = this.pendingByOwner.get(ownerIpHash) ?? 1;
        if (cur <= 1) {
          this.pendingByOwner.delete(ownerIpHash);
        } else {
          this.pendingByOwner.set(ownerIpHash, cur - 1);
        }
      }
    }
  }

  private notifySessionWaiters(ws: WorkspaceEntry, sid: SessionId): void {
    const waiters = ws.sessionWaiters[sid];
    if (!waiters || waiters.length === 0) return;
    ws.sessionWaiters[sid] = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private waitForAnySessionRelease(
    ws: WorkspaceEntry,
    pending: SessionId[],
    maxWaitMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const cleanups: Array<() => void> = [];
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const fn of cleanups) fn();
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, maxWaitMs));
      for (const sid of pending) {
        const list = (ws.sessionWaiters[sid] ??= []);
        list.push(done);
        cleanups.push(() => {
          const arr = ws.sessionWaiters[sid];
          if (!arr) return;
          const idx = arr.indexOf(done);
          if (idx !== -1) arr.splice(idx, 1);
        });
      }
    });
  }

  private async killSessionThread(ws: WorkspaceEntry, sid: SessionId): Promise<void> {
    const session = ws.sessions[sid];
    if (!session) return;
    try {
      await this.adminPool.query(`KILL QUERY ${Math.trunc(session.threadId)}`);
    } catch (err) {
      const mysqlErr = err as { errno?: number };
      // ER_NO_SUCH_THREAD (1094) means query/connection already ended
      if (mysqlErr.errno !== 1094) {
        throw err;
      }
    }
  }

  private async acquireAllSessionLocksForTeardown(
    ws: WorkspaceEntry,
    timeoutMs = DEFAULT_TEARDOWN_TIMEOUT_MS,
  ): Promise<SessionId[]> {
    const acquired: SessionId[] = [];
    const deadline = Date.now() + timeoutMs;
    ws.sessionAbort.A = true;
    ws.sessionAbort.B = true;

    try {
      while (acquired.length < 2) {
        for (const sid of ['A', 'B'] as const) {
          if (acquired.includes(sid)) continue;
          if (!ws.sessionLocks[sid] && !ws.sessions[sid]?.busy) {
            ws.sessionLocks[sid] = true;
            acquired.push(sid);
          }
        }
        if (acquired.length === 2) {
          return acquired;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new ApiError(
            503,
            'SESSION_TEARDOWN_TIMEOUT',
            'Timed out waiting for active session queries to stop',
          );
        }

        const pending = (['A', 'B'] as const).filter((sid) => !acquired.includes(sid));
        await Promise.all(
          pending.map((sid) =>
            this.killSessionThread(ws, sid).catch((err) => {
              this.logger.warn(
                { err, wsId: ws.wsId, session: sid },
                'KILL QUERY during teardown failed',
              );
            }),
          ),
        );

        // Re-check immediately after KILL QUERY in case release already happened during await
        let needWait = false;
        for (const sid of pending) {
          if (!ws.sessionLocks[sid] && !ws.sessions[sid]?.busy) {
            ws.sessionLocks[sid] = true;
            acquired.push(sid);
          } else {
            needWait = true;
          }
        }
        if (!needWait || acquired.length === 2) {
          continue;
        }

        const stillPending = (['A', 'B'] as const).filter((sid) => !acquired.includes(sid));
        const waitSlice = Math.min(Math.max(1, deadline - Date.now()), 200);
        await this.waitForAnySessionRelease(ws, stillPending, waitSlice);
      }
      return acquired;
    } catch (err) {
      ws.sessionAbort.A = false;
      ws.sessionAbort.B = false;
      for (const sid of acquired) {
        this.releaseSession(ws, sid);
      }
      throw err;
    }
  }

  async resetWorkspace(
    wsId: string,
    datasetId: string,
    timeoutMs = DEFAULT_TEARDOWN_TIMEOUT_MS,
  ): Promise<{ database: string }> {
    this.assertValidDataset(datasetId);
    const ws = this.getWorkspace(wsId);
    if (ws.teardownActive || ws.deleting) {
      throw new ApiError(
        409,
        'WORKSPACE_BUSY',
        'Workspace is currently resetting or being deleted',
      );
    }

    ws.teardownActive = true;
    let acquired: SessionId[] = [];
    try {
      acquired = await this.acquireAllSessionLocksForTeardown(ws, timeoutMs);
      await this.closeAllSessions(ws);
      await this.dropDbAndUser(ws.database, ws.dbUser);

      const newPassword = randomBytes(32).toString('base64url');
      ws.password = newPassword;
      ws.dataset = datasetId;

      await this.provisionDbAndUser(ws.database, ws.dbUser, ws.password);
      if (datasetId !== 'empty') {
        await this.cloneTemplate(templateDbName(datasetId), ws.database, ws.dbUser, ws.password);
      }

      this.touchWorkspace(ws);
      return { database: ws.database };
    } finally {
      ws.sessionAbort.A = false;
      ws.sessionAbort.B = false;
      ws.teardownActive = false;
      for (const sid of acquired) {
        this.releaseSession(ws, sid);
      }
    }
  }

  async deleteWorkspace(
    wsId: string,
    timeoutMs = DEFAULT_TEARDOWN_TIMEOUT_MS,
    expectedOwnerIpHash?: string,
  ): Promise<void> {
    const ws = this.workspaces.get(wsId);
    if (!ws || ws.deleting) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found or expired');
    }
    if (
      expectedOwnerIpHash !== undefined &&
      ws.ownerIpHash &&
      ws.ownerIpHash !== expectedOwnerIpHash
    ) {
      throw new ApiError(403, 'FORBIDDEN', 'Workspace does not belong to this client');
    }
    if (ws.teardownActive) {
      throw new ApiError(409, 'WORKSPACE_BUSY', 'Workspace is currently resetting');
    }

    ws.deleting = true;
    ws.teardownActive = true;
    let acquired: SessionId[] = [];
    let deleted = false;
    try {
      acquired = await this.acquireAllSessionLocksForTeardown(ws, timeoutMs);
      this.workspaces.delete(wsId);
      deleted = true;
      await this.closeAllSessions(ws);
      await this.dropDbAndUser(ws.database, ws.dbUser);
    } finally {
      if (!deleted) {
        ws.deleting = false;
      }
      ws.sessionAbort.A = false;
      ws.sessionAbort.B = false;
      ws.teardownActive = false;
      for (const sid of acquired) {
        this.releaseSession(ws, sid);
      }
    }
  }

  async acquireSession(ws: WorkspaceEntry, sessionId: SessionId): Promise<PinnedSession> {
    if (ws.deleting) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found or expired');
    }
    if (ws.teardownActive) {
      throw new ApiError(
        409,
        'WORKSPACE_BUSY',
        'Workspace is currently resetting or being deleted',
      );
    }
    if (ws.sessionLocks[sessionId] || ws.sessions[sessionId]?.busy) {
      throw new ApiError(
        409,
        'SESSION_BUSY',
        `Session ${sessionId} is already executing a statement`,
      );
    }
    ws.sessionLocks[sessionId] = true;
    try {
      const session = await this.getOrCreateSession(ws, sessionId);
      if (ws.deleting || ws.teardownActive || ws.sessionAbort[sessionId]) {
        throw new ApiError(
          409,
          'WORKSPACE_BUSY',
          'Workspace is currently resetting or being deleted',
        );
      }
      session.busy = true;
      return session;
    } catch (err) {
      this.releaseSession(ws, sessionId);
      throw err;
    }
  }

  releaseSession(ws: WorkspaceEntry, sessionId: SessionId, session?: PinnedSession): void {
    if (session) {
      session.busy = false;
      session.lastUsedAt = Date.now();
    }
    ws.sessionLocks[sessionId] = false;
    this.notifySessionWaiters(ws, sessionId);
  }

  async getOrCreateSession(ws: WorkspaceEntry, sessionId: SessionId): Promise<PinnedSession> {
    const existing = ws.sessions[sessionId];
    if (existing) {
      if (existing.busy) {
        return existing;
      }
      try {
        await existing.conn.ping();
        existing.lastUsedAt = Date.now();
        return existing;
      } catch {
        delete ws.sessions[sessionId];
        await existing.conn.end().catch(() => {});
      }
    }

    const conn = await mysql.createConnection({
      host: this.config.DB_HOST,
      port: this.config.DB_PORT,
      user: ws.dbUser,
      password: ws.password,
      database: ws.database,
      charset: 'utf8mb4',
      multipleStatements: false,
      dateStrings: true,
      decimalNumbers: false,
    });

    await conn.query('SET SESSION max_statement_time = 5');
    await conn.query(`SET SESSION sql_select_limit = ${this.config.ROW_CAP + 1}`);
    const threadId = conn.threadId;
    if (typeof threadId !== 'number') {
      await conn.end().catch(() => {});
      throw new ApiError(500, 'SESSION_INIT_FAILED', 'Could not obtain connection thread id');
    }

    const pinned: PinnedSession = {
      id: sessionId,
      conn,
      threadId,
      busy: false,
      lastUsedAt: Date.now(),
    };
    ws.sessions[sessionId] = pinned;
    return pinned;
  }

  async killSessionQuery(wsId: string, sessionId: SessionId): Promise<void> {
    const ws = this.getWorkspace(wsId);
    await this.killSessionThread(ws, sessionId);
  }

  async closeAllSessions(ws: WorkspaceEntry): Promise<void> {
    for (const sid of ['A', 'B'] as const) {
      const session = ws.sessions[sid];
      if (!session) continue;
      delete ws.sessions[sid];
      await session.conn.end().catch(() => {
        session.conn.destroy();
      });
    }
  }

  async closeAllWorkspaces(dropRemote = false): Promise<void> {
    this.stopJanitor();
    const entries = [...this.workspaces.values()];
    for (const ws of entries) {
      await this.closeAllSessions(ws);
      if (dropRemote) {
        this.workspaces.delete(ws.wsId);
        await this.dropDbAndUser(ws.database, ws.dbUser).catch((err) => {
          this.logger.warn({ err, database: ws.database }, 'Failed to drop workspace on shutdown');
        });
      }
    }
  }

  startJanitor(): void {
    if (this.janitorTimer) return;
    this.janitorTimer = setInterval(() => {
      void this.runJanitorSweep().catch((err) => {
        this.logger.error({ err }, 'Janitor sweep failed');
      });
    }, this.config.JANITOR_INTERVAL_MS);
    this.janitorTimer.unref();
  }

  stopJanitor(): void {
    if (this.janitorTimer) {
      clearInterval(this.janitorTimer);
      this.janitorTimer = null;
    }
  }

  async cleanupOrphans(): Promise<{ droppedDatabases: number; droppedUsers: number }> {
    const liveDbs = new Set([...this.workspaces.values()].map((w) => w.database));
    const liveUsers = new Set([...this.workspaces.values()].map((w) => w.dbUser));

    const [schemas] = await this.adminPool.query<SchemaNameRow[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'ws\\_%'",
    );

    let droppedDatabases = 0;
    for (const row of schemas) {
      if (liveDbs.has(row.SCHEMA_NAME)) continue;
      await this.adminPool.query(`DROP DATABASE IF EXISTS ${escapeIdent(row.SCHEMA_NAME)}`);
      droppedDatabases += 1;
    }

    const [users] = await this.adminPool.query<UserHostRow[]>(
      "SELECT User, Host FROM mysql.user WHERE User LIKE 'ws\\_%'",
    );

    let droppedUsers = 0;
    for (const row of users) {
      if (liveUsers.has(row.User)) continue;
      await this.adminPool.query(
        `DROP USER IF EXISTS ${mysql.escape(row.User)}@${mysql.escape(row.Host)}`,
      );
      droppedUsers += 1;
    }

    if (droppedDatabases > 0 || droppedUsers > 0) {
      this.logger.info({ droppedDatabases, droppedUsers }, 'Cleaned up orphaned workspaces');
    }
    return { droppedDatabases, droppedUsers };
  }

  async runJanitorSweep(): Promise<{
    expiredWorkspaces: number;
    closedIdleSessions: number;
    truncatedWorkspaces: number;
  }> {
    const now = Date.now();
    let expiredWorkspaces = 0;
    let closedIdleSessions = 0;
    let truncatedWorkspaces = 0;

    // 1. Workspace idle TTL (2 h) and absolute max TTL (12 h).
    // Idle-expired workspaces wait for active sessions; workspaces past absoluteExpiresAt
    // are forcibly torn down via deleteWorkspace (which sets sessionAbort and runs KILL QUERY).
    for (const [wsId, ws] of [...this.workspaces.entries()]) {
      const pastAbsolute = now >= ws.absoluteExpiresAt;
      if (now >= ws.expiresAt || pastAbsolute) {
        if (ws.teardownActive || ws.deleting) continue;
        if (!pastAbsolute && this.isWorkspaceBusy(ws)) {
          this.logger.debug(
            { wsId, database: ws.database },
            'Skipping expired workspace with busy session until next janitor sweep',
          );
          continue;
        }
        const reason = pastAbsolute ? 'absolute_ttl' : 'idle_ttl';
        this.logger.info({ wsId, database: ws.database, reason }, 'Expiring workspace');
        try {
          await this.deleteWorkspace(wsId);
          expiredWorkspaces += 1;
        } catch (err) {
          this.logger.warn({ err, wsId }, 'Failed to expire workspace');
        }
      }
    }

    // 2. Idle session timeout (10 min) with open-tx rollback — skip busy/locked sessions
    for (const ws of this.workspaces.values()) {
      if (ws.teardownActive || ws.deleting) continue;
      for (const sid of ['A', 'B'] as const) {
        const session = ws.sessions[sid];
        if (!session || session.busy || ws.sessionLocks[sid]) continue;
        if (now - session.lastUsedAt < this.config.SESSION_IDLE_TTL_MS) continue;

        ws.sessionLocks[sid] = true;
        try {
          const current = ws.sessions[sid];
          if (!current || current !== session || current.busy || ws.teardownActive || ws.deleting) {
            continue;
          }
          try {
            const [txRows] = await session.conn.query<RowDataPacket[]>(
              'SELECT @@in_transaction AS in_tx',
            );
            const inTx = Number(txRows[0]?.in_tx ?? 0) === 1;
            if (inTx) {
              await session.conn.query('ROLLBACK');
              this.logger.info(
                { wsId: ws.wsId, session: sid },
                'Rolled back idle open transaction',
              );
            }
          } catch {
            // Connection may already be dead
          }
          delete ws.sessions[sid];
          await session.conn.end().catch(() => {
            session.conn.destroy();
          });
          closedIdleSessions += 1;
        } finally {
          this.releaseSession(ws, sid);
        }
      }
    }

    // 3. Per-workspace 50 MB size cap — forcibly reset oversized workspaces even if busy
    const sizes = await this.getWorkspaceSizes();
    for (const ws of [...this.workspaces.values()]) {
      if (ws.teardownActive || ws.deleting) continue;
      const bytes = sizes.get(ws.database) ?? 0;
      if (bytes > this.config.MAX_WORKSPACE_BYTES) {
        this.logger.warn(
          { wsId: ws.wsId, database: ws.database, bytes, cap: this.config.MAX_WORKSPACE_BYTES },
          'Workspace exceeded size cap; interrupting active sessions and re-provisioning',
        );
        try {
          await this.resetWorkspace(ws.wsId, ws.dataset);
          truncatedWorkspaces += 1;
        } catch (err) {
          this.logger.error({ err, wsId: ws.wsId }, 'Failed to reset oversized workspace');
        }
      }
    }

    return { expiredWorkspaces, closedIdleSessions, truncatedWorkspaces };
  }

  private async getWorkspaceSizes(): Promise<Map<string, number>> {
    const [rows] = await this.adminPool.query<SchemaSizeRow[]>(
      `SELECT table_schema, COALESCE(SUM(data_length + index_length), 0) AS bytes
       FROM information_schema.TABLES
       WHERE table_schema LIKE 'ws\\_%'
       GROUP BY table_schema`,
    );
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.table_schema, Number(row.bytes) || 0);
    }
    return map;
  }

  private async getTotalWorkspaceBytes(): Promise<number> {
    const sizes = await this.getWorkspaceSizes();
    let total = 0;
    for (const bytes of sizes.values()) {
      total += bytes;
    }
    return total;
  }

  private async provisionDbAndUser(
    database: string,
    dbUser: string,
    password: string,
  ): Promise<void> {
    const conn = await this.adminPool.getConnection();
    try {
      const dbIdent = escapeIdent(database);
      const userLit = mysql.escape(dbUser);
      const pwdLit = mysql.escape(password);

      await conn.query(
        `CREATE DATABASE ${dbIdent} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      await conn.query(
        `CREATE USER ${userLit}@'%' IDENTIFIED BY ${pwdLit}
         WITH MAX_USER_CONNECTIONS 3 MAX_QUERIES_PER_HOUR 100000 MAX_UPDATES_PER_HOUR 100000 MAX_STATEMENT_TIME 5`,
      );
      await conn.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES,
               CREATE VIEW, SHOW VIEW, TRIGGER, CREATE TEMPORARY TABLES, LOCK TABLES,
               CREATE ROUTINE, ALTER ROUTINE, EXECUTE
         ON ${escapeGrantDbIdent(database)}.* TO ${userLit}@'%'`,
      );
    } finally {
      conn.release();
    }
  }

  private async dropDbAndUser(database: string, dbUser: string): Promise<void> {
    const conn = await this.adminPool.getConnection();
    try {
      await conn.query(`DROP DATABASE IF EXISTS ${escapeIdent(database)}`);
      await conn.query(`DROP USER IF EXISTS ${mysql.escape(dbUser)}@'%'`);
    } finally {
      conn.release();
    }
  }

  private async cloneTemplate(
    templateDb: string,
    targetDb: string,
    wsUser: string,
    wsPassword: string,
  ): Promise<void> {
    const conn: PoolConnection = await this.adminPool.getConnection();
    try {
      const [tableRows] = await conn.query<TableNameRow[]>(
        `SELECT TABLE_NAME
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
        [templateDb],
      );
      const tables = tableRows.map((r) => r.TABLE_NAME);

      const [fkRows] = await conn.query<FkEdgeRow[]>(
        `SELECT TABLE_NAME, REFERENCED_TABLE_NAME
         FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [templateDb],
      );

      const orderedTables = topoSortTables(
        tables,
        fkRows.map((r) => ({ table: r.TABLE_NAME, refTable: r.REFERENCED_TABLE_NAME })),
      );

      const tplIdent = escapeIdent(templateDb);
      const dstIdent = escapeIdent(targetDb);

      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      try {
        await conn.query(`USE ${dstIdent}`);

        for (const table of orderedTables) {
          const tblIdent = escapeIdent(table);
          const [createRows] = await conn.query<RowDataPacket[]>(
            `SHOW CREATE TABLE ${tplIdent}.${tblIdent}`,
          );
          const ddl = createRows[0]?.['Create Table'];
          if (typeof ddl !== 'string') {
            throw new Error(`SHOW CREATE TABLE failed for ${templateDb}.${table}`);
          }
          // NEVER use CREATE TABLE ... LIKE (drops foreign keys). Run full DDL inside targetDb.
          await conn.query(ddl);
          await conn.query(
            `INSERT INTO ${dstIdent}.${tblIdent} SELECT * FROM ${tplIdent}.${tblIdent}`,
          );
        }
      } finally {
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      }

      // Clone views and triggers if present in the template (executed as wsUser so DEFINER = wsUser)
      const [viewRows] = await conn.query<ViewNameRow[]>(
        `SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [templateDb],
      );
      const [triggerRows] = await conn.query<TriggerNameRow[]>(
        `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
        [templateDb],
      );

      if (viewRows.length > 0 || triggerRows.length > 0) {
        const wsConn = await mysql.createConnection({
          host: this.config.DB_HOST,
          port: this.config.DB_PORT,
          user: wsUser,
          password: wsPassword,
          database: targetDb,
          charset: 'utf8mb4',
        });
        try {
          const tplQualRegex = new RegExp(`\`${templateDb}\`\\.`, 'g');

          for (const v of viewRows) {
            const [vCreate] = await conn.query<RowDataPacket[]>(
              `SHOW CREATE VIEW ${tplIdent}.${escapeIdent(v.TABLE_NAME)}`,
            );
            let ddl = vCreate[0]?.['Create View'];
            if (typeof ddl !== 'string') continue;
            ddl = ddl
              .replace(/DEFINER=`[^`]+`@`[^`]+`\s+/i, '')
              .replace(tplQualRegex, `${dstIdent}.`);
            await wsConn.query(ddl);
          }

          for (const tr of triggerRows) {
            const [tCreate] = await conn.query<RowDataPacket[]>(
              `SHOW CREATE TRIGGER ${tplIdent}.${escapeIdent(tr.TRIGGER_NAME)}`,
            );
            let ddl = tCreate[0]?.['SQL Original Statement'];
            if (typeof ddl !== 'string') continue;
            ddl = ddl
              .replace(/DEFINER=`[^`]+`@`[^`]+`\s+/i, '')
              .replace(tplQualRegex, `${dstIdent}.`);
            await wsConn.query(ddl);
          }
        } finally {
          await wsConn.end();
        }
      }
    } finally {
      conn.release();
    }
  }
}
