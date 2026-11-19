import { randomBytes } from 'node:crypto';
import mysql, { type Connection, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import type { FastifyBaseLogger } from 'fastify';
import type { DatasetMeta, SessionId } from '@sqlyard/shared';
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
  sessions: Partial<Record<SessionId, PinnedSession>>;
}

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
    if (!ws) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found or expired');
    }
    if (Date.now() >= ws.expiresAt) {
      void this.deleteWorkspace(wsId).catch(() => {});
      throw new ApiError(404, 'WORKSPACE_EXPIRED', 'Workspace expired');
    }
    return ws;
  }

  touchWorkspace(ws: WorkspaceEntry): void {
    const now = Date.now();
    ws.lastActiveAt = now;
    ws.expiresAt = now + this.config.WORKSPACE_TTL_MS;
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

  async createWorkspace(datasetId: string): Promise<{
    wsId: string;
    database: string;
    expiresAt: string;
  }> {
    this.assertValidDataset(datasetId);

    if (this.workspaces.size >= this.config.MAX_WORKSPACES) {
      throw new ApiError(
        503,
        'WORKSPACE_LIMIT_REACHED',
        `Maximum live workspaces (${this.config.MAX_WORKSPACES}) reached`,
      );
    }

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
    const now = Date.now();

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

    const entry: WorkspaceEntry = {
      wsId,
      database,
      dbUser,
      password,
      dataset: datasetId,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + this.config.WORKSPACE_TTL_MS,
      sessions: {},
    };
    this.workspaces.set(wsId, entry);

    return {
      wsId,
      database,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  async resetWorkspace(wsId: string, datasetId: string): Promise<{ database: string }> {
    this.assertValidDataset(datasetId);
    const ws = this.getWorkspace(wsId);

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
  }

  async deleteWorkspace(wsId: string): Promise<void> {
    const ws = this.workspaces.get(wsId);
    if (!ws) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found or expired');
    }
    this.workspaces.delete(wsId);
    await this.closeAllSessions(ws);
    await this.dropDbAndUser(ws.database, ws.dbUser);
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
    const session = ws.sessions[sessionId];
    if (!session) {
      return;
    }
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

    // 1. Idle workspace TTL (24 h)
    for (const [wsId, ws] of [...this.workspaces.entries()]) {
      if (now >= ws.expiresAt) {
        this.logger.info({ wsId, database: ws.database }, 'Expiring idle workspace');
        await this.deleteWorkspace(wsId).catch((err) => {
          this.logger.warn({ err, wsId }, 'Failed to expire workspace');
        });
        expiredWorkspaces += 1;
      }
    }

    // 2. Idle session timeout (15 min) with open-tx rollback
    for (const ws of this.workspaces.values()) {
      for (const sid of ['A', 'B'] as const) {
        const session = ws.sessions[sid];
        if (!session || session.busy) continue;
        if (now - session.lastUsedAt < this.config.SESSION_IDLE_TTL_MS) continue;

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
      }
    }

    // 3. Per-workspace 50 MB size cap
    const sizes = await this.getWorkspaceSizes();
    for (const ws of [...this.workspaces.values()]) {
      const bytes = sizes.get(ws.database) ?? 0;
      if (bytes > this.config.MAX_WORKSPACE_BYTES) {
        this.logger.warn(
          { wsId: ws.wsId, database: ws.database, bytes, cap: this.config.MAX_WORKSPACE_BYTES },
          'Workspace exceeded size cap; truncating and re-provisioning',
        );
        await this.resetWorkspace(ws.wsId, ws.dataset).catch((err) => {
          this.logger.error({ err, wsId: ws.wsId }, 'Failed to reset oversized workspace');
        });
        truncatedWorkspaces += 1;
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
          await conn.query(`INSERT INTO ${dstIdent}.${tblIdent} SELECT * FROM ${tplIdent}.${tblIdent}`);
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
