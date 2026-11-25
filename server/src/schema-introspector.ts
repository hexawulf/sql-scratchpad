import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type {
  SchemaColumn,
  SchemaForeignKey,
  SchemaIndex,
  SchemaTable,
  SchemaTree,
  SchemaView,
} from '@sql-scratchpad/shared';
import { ApiError } from './errors.js';

interface BaseTableRow extends RowDataPacket {
  TABLE_NAME: string;
}

interface ColumnRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_KEY: string;
  COLUMN_DEFAULT: string | null;
  EXTRA: string;
}

interface StatRow extends RowDataPacket {
  TABLE_NAME: string;
  INDEX_NAME: string;
  COLUMN_NAME: string;
  NON_UNIQUE: number;
}

interface FkRow extends RowDataPacket {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  DELETE_RULE: string;
  UPDATE_RULE: string;
}

interface TriggerRow extends RowDataPacket {
  EVENT_OBJECT_TABLE: string;
  TRIGGER_NAME: string;
}

interface ViewRow extends RowDataPacket {
  TABLE_NAME: string;
  VIEW_DEFINITION: string | null;
}

function normalizeColumnKey(key: string): SchemaColumn['key'] {
  if (key === 'PRI' || key === 'UNI' || key === 'MUL') return key;
  return '';
}

const MAX_CONCURRENT_INTROSPECTIONS = 3;
let activeIntrospections = 0;
const inFlightByDb = new Map<string, Promise<SchemaTree>>();

async function runIntrospectionOnSingleConnection(
  adminPool: Pool,
  database: string,
): Promise<SchemaTree> {
  const conn: PoolConnection | null =
    typeof adminPool.getConnection === 'function' ? await adminPool.getConnection() : null;
  const queryable = conn ?? adminPool;
  try {
    const [tableRows] = await queryable.query<BaseTableRow[]>(
      `SELECT TABLE_NAME
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [database],
    );
    const [colRows] = await queryable.query<ColumnRow[]>(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database],
    );
    const [statRows] = await queryable.query<StatRow[]>(
      `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [database],
    );
    const [fkRows] = await queryable.query<FkRow[]>(
      `SELECT kcu.TABLE_NAME,
              kcu.CONSTRAINT_NAME,
              kcu.COLUMN_NAME,
              kcu.REFERENCED_TABLE_NAME,
              kcu.REFERENCED_COLUMN_NAME,
              rc.DELETE_RULE,
              rc.UPDATE_RULE
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND rc.TABLE_NAME = kcu.TABLE_NAME
       WHERE kcu.TABLE_SCHEMA = ?
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [database],
    );
    const [trigRows] = await queryable.query<TriggerRow[]>(
      `SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME
       FROM information_schema.TRIGGERS
       WHERE EVENT_OBJECT_SCHEMA = ?
       ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`,
      [database],
    );
    const [viewRows] = await queryable.query<ViewRow[]>(
      `SELECT TABLE_NAME, VIEW_DEFINITION
       FROM information_schema.VIEWS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [database],
    );

    const tableMap = new Map<string, SchemaTable>();
    for (const t of tableRows) {
      tableMap.set(t.TABLE_NAME, {
        name: t.TABLE_NAME,
        columns: [],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      });
    }

    for (const c of colRows) {
      const tbl = tableMap.get(c.TABLE_NAME);
      if (!tbl) continue;
      tbl.columns.push({
        name: c.COLUMN_NAME,
        type: c.COLUMN_TYPE,
        nullable: c.IS_NULLABLE === 'YES',
        key: normalizeColumnKey(c.COLUMN_KEY),
        default: c.COLUMN_DEFAULT,
        extra: c.EXTRA,
      });
    }

    const indexGroups = new Map<string, Map<string, SchemaIndex>>();
    for (const s of statRows) {
      if (!tableMap.has(s.TABLE_NAME)) continue;
      let byIdx = indexGroups.get(s.TABLE_NAME);
      if (!byIdx) {
        byIdx = new Map();
        indexGroups.set(s.TABLE_NAME, byIdx);
      }
      let idx = byIdx.get(s.INDEX_NAME);
      if (!idx) {
        idx = {
          name: s.INDEX_NAME,
          columns: [],
          unique: Number(s.NON_UNIQUE) === 0,
        };
        byIdx.set(s.INDEX_NAME, idx);
      }
      idx.columns.push(s.COLUMN_NAME);
    }
    for (const [tblName, byIdx] of indexGroups.entries()) {
      const tbl = tableMap.get(tblName);
      if (tbl) tbl.indexes.push(...byIdx.values());
    }

    const fkGroups = new Map<string, Map<string, SchemaForeignKey>>();
    for (const f of fkRows) {
      if (!tableMap.has(f.TABLE_NAME)) continue;
      let byFk = fkGroups.get(f.TABLE_NAME);
      if (!byFk) {
        byFk = new Map();
        fkGroups.set(f.TABLE_NAME, byFk);
      }
      let fk = byFk.get(f.CONSTRAINT_NAME);
      if (!fk) {
        fk = {
          name: f.CONSTRAINT_NAME,
          columns: [],
          refTable: f.REFERENCED_TABLE_NAME,
          refColumns: [],
          onDelete: f.DELETE_RULE,
          onUpdate: f.UPDATE_RULE,
        };
        byFk.set(f.CONSTRAINT_NAME, fk);
      }
      fk.columns.push(f.COLUMN_NAME);
      fk.refColumns.push(f.REFERENCED_COLUMN_NAME);
    }
    for (const [tblName, byFk] of fkGroups.entries()) {
      const tbl = tableMap.get(tblName);
      if (tbl) tbl.foreignKeys.push(...byFk.values());
    }

    for (const tr of trigRows) {
      const tbl = tableMap.get(tr.EVENT_OBJECT_TABLE);
      if (tbl) tbl.triggers.push(tr.TRIGGER_NAME);
    }

    const views: SchemaView[] = viewRows.map((v) => ({
      name: v.TABLE_NAME,
      ...(v.VIEW_DEFINITION ? { definition: v.VIEW_DEFINITION } : {}),
    }));

    return {
      database,
      engine: 'mariadb',
      tables: [...tableMap.values()],
      views,
    };
  } finally {
    conn?.release();
  }
}

export async function introspectWorkspaceSchema(
  adminPool: Pool,
  database: string,
): Promise<SchemaTree> {
  const existing = inFlightByDb.get(database);
  if (existing) {
    return existing;
  }

  if (activeIntrospections >= MAX_CONCURRENT_INTROSPECTIONS) {
    throw new ApiError(
      503,
      'SCHEMA_BUSY',
      'Schema introspection is temporarily busy; please retry shortly',
      2,
    );
  }

  activeIntrospections += 1;
  const promise = runIntrospectionOnSingleConnection(adminPool, database).finally(() => {
    inFlightByDb.delete(database);
    activeIntrospections = Math.max(0, activeIntrospections - 1);
  });
  inFlightByDb.set(database, promise);
  return promise;
}
