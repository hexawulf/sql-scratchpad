import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface MysqlConnection {
  query<T = unknown[]>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
  end(): Promise<void>;
}

interface MysqlModule {
  createConnection(config: {
    host: string;
    port: number;
    user: string;
    password: string;
    multipleStatements?: boolean;
  }): Promise<MysqlConnection>;
}

interface DotenvModule {
  config(opts?: { path?: string }): { error?: Error };
}

interface SqlJsDatabase {
  run(sql: string): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
}

interface SqlJsModule {
  Database: new () => SqlJsDatabase;
}

type InitSqlJs = () => Promise<SqlJsModule>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'seeds', 'sample-library.sql');

const serverRequire = createRequire(path.join(ROOT, 'server', 'package.json'));
const rootRequire = createRequire(path.join(ROOT, 'package.json'));

const dotenv = serverRequire('dotenv') as DotenvModule;
const mysql = serverRequire('mysql2/promise') as MysqlModule;
const initSqlJs = rootRequire('sql.js') as InitSqlJs;

dotenv.config({ path: path.join(ROOT, '.env') });

const EXPECTED_TABLES: ReadonlyArray<{ table: string; rows: number }> = [
  { table: 'Authors', rows: 10 },
  { table: 'BookAuthors', rows: 14 },
  { table: 'Books', rows: 12 },
  { table: 'Loans', rows: 15 },
  { table: 'Members', rows: 9 },
];

const EXPECTED_FK_COUNT = 5;

async function inspectMariaDbSchema(
  conn: MysqlConnection,
  schemaName: string,
): Promise<{ counts: Map<string, number>; fkCount: number }> {
  const [tableRows] = await conn.query<Array<{ TABLE_NAME: string }>>(
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [schemaName],
  );

  const counts = new Map<string, number>();
  for (const { TABLE_NAME } of tableRows) {
    const [cntRows] = await conn.query<Array<{ cnt: number }>>(
      `SELECT COUNT(*) AS cnt FROM \`${schemaName}\`.\`${TABLE_NAME}\``,
    );
    counts.set(TABLE_NAME, Number(cntRows[0]?.cnt ?? -1));
  }

  const [fkRows] = await conn.query<Array<{ cnt: number }>>(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = ?`,
    [schemaName],
  );
  const fkCount = Number(fkRows[0]?.cnt ?? 0);

  return { counts, fkCount };
}

async function verifyMariaDb(seedSql: string): Promise<{
  templateCounts: Map<string, number>;
  freshCounts: Map<string, number>;
  fkCount: number;
}> {
  const host = process.env.DB_HOST ?? '127.0.0.1';
  const port = Number(process.env.DB_PORT ?? '3307');
  const password = process.env.SQLSCRATCHPAD_ADMIN_PASSWORD;

  if (!password) {
    throw new Error('SQLSCRATCHPAD_ADMIN_PASSWORD is not set in environment or .env');
  }

  console.log(`=== MariaDB verification (${host}:${port} as scratchpad_admin) ===`);
  const conn = await mysql.createConnection({
    host,
    port,
    user: 'scratchpad_admin',
    password,
    multipleStatements: true,
  });

  const tempDb = `ws_seed_verify_${randomBytes(4).toString('hex')}`;

  try {
    const [verRows] = await conn.query<Array<{ v: string }>>('SELECT VERSION() AS v');
    console.log(`Server version: ${verRows[0]?.v ?? 'unknown'}`);

    // 1. Verify pre-seeded template database tpl_sample_library
    const tpl = await inspectMariaDbSchema(conn, 'tpl_sample_library');
    for (const [table, count] of tpl.counts) {
      console.log(`  PASS tpl_sample_library.${table}: ${count} rows`);
    }
    if (tpl.fkCount !== EXPECTED_FK_COUNT) {
      throw new Error(
        `MariaDB tpl_sample_library FK count mismatch: expected ${EXPECTED_FK_COUNT}, got ${tpl.fkCount}`,
      );
    }
    console.log(`  PASS tpl_sample_library REFERENTIAL_CONSTRAINTS: ${tpl.fkCount} foreign keys`);

    // 2. Load seeds/sample-library.sql directly into a fresh database and verify
    await conn.query(
      `CREATE DATABASE \`${tempDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.query(`USE \`${tempDb}\``);
    const start = process.hrtime.bigint();
    await conn.query(seedSql);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    const fresh = await inspectMariaDbSchema(conn, tempDb);
    if (fresh.fkCount !== EXPECTED_FK_COUNT) {
      throw new Error(
        `MariaDB fresh load FK count mismatch: expected ${EXPECTED_FK_COUNT}, got ${fresh.fkCount}`,
      );
    }
    console.log(
      `  PASS fresh MariaDB load (${tempDb}): ${fresh.counts.size} tables, ${fresh.fkCount} foreign keys (${elapsedMs.toFixed(1)} ms)`,
    );

    // 3. Assert CHECK constraint chk_loans_dates rejects due_date <= loaned_date
    let checkRejected = false;
    try {
      await conn.query(
        "INSERT INTO Loans (loan_id, book_id, member_id, loaned_date, due_date, returned_date, late_fee) VALUES (999, 101, 201, '2025-10-10', '2025-10-10', NULL, NULL)",
      );
    } catch {
      checkRejected = true;
    }
    if (!checkRejected) {
      throw new Error(
        'MariaDB did not reject INSERT violating chk_loans_dates (due_date > loaned_date)',
      );
    }
    console.log('  PASS MariaDB CHECK constraint chk_loans_dates rejected invalid dates');

    return { templateCounts: tpl.counts, freshCounts: fresh.counts, fkCount: fresh.fkCount };
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${tempDb}\``).catch(() => {});
    await conn.end();
  }
}

async function verifySqlite(seedSql: string): Promise<{
  counts: Map<string, number>;
  fkCount: number;
}> {
  console.log('\n=== SQLite (sql.js) verification ===');
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  try {
    db.run('PRAGMA foreign_keys = ON;');
    const start = process.hrtime.bigint();
    db.run(seedSql);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    const tableRes = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    );
    const tableNames = (tableRes[0]?.values ?? []).map((r) => String(r[0]));

    const counts = new Map<string, number>();
    let fkCount = 0;

    for (const name of tableNames) {
      const cntRes = db.exec(`SELECT COUNT(*) FROM "${name}";`);
      const count = Number(cntRes[0]?.values[0]?.[0] ?? -1);
      counts.set(name, count);
      console.log(`  PASS sqlite/sample-library.${name}: ${count} rows`);

      const fkRes = db.exec(`PRAGMA foreign_key_list("${name}");`);
      fkCount += fkRes[0]?.values.length ?? 0;
    }

    if (fkCount !== EXPECTED_FK_COUNT) {
      throw new Error(`SQLite FK count mismatch: expected ${EXPECTED_FK_COUNT}, got ${fkCount}`);
    }
    console.log(
      `  PASS sqlite/sample-library foreign keys: ${fkCount} (loaded in ${elapsedMs.toFixed(1)} ms)`,
    );

    let checkRejected = false;
    try {
      db.run(
        "INSERT INTO Loans (loan_id, book_id, member_id, loaned_date, due_date, returned_date, late_fee) VALUES (999, 101, 201, '2025-10-10', '2025-10-10', NULL, NULL);",
      );
    } catch {
      checkRejected = true;
    }
    if (!checkRejected) {
      throw new Error(
        'SQLite did not reject INSERT violating chk_loans_dates (due_date > loaned_date)',
      );
    }
    console.log(
      '  PASS sqlite/sample-library CHECK constraint chk_loans_dates rejected invalid dates',
    );

    return { counts, fkCount };
  } finally {
    db.close();
  }
}

function assertIdenticalCounts(
  label: string,
  actual: Map<string, number>,
  reference: Map<string, number>,
): void {
  const actualKeys = [...actual.keys()].sort();
  const refKeys = [...reference.keys()].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(refKeys)) {
    throw new Error(
      `Table list mismatch for ${label}: expected [${refKeys.join(', ')}], got [${actualKeys.join(', ')}]`,
    );
  }
  for (const table of refKeys) {
    const a = actual.get(table);
    const r = reference.get(table);
    if (a !== r) {
      throw new Error(`Row count mismatch for ${label}.${table}: expected ${r}, got ${a}`);
    }
  }
}

async function main(): Promise<void> {
  const seedSql = readFileSync(SEED_PATH, 'utf8');
  const expected = new Map(EXPECTED_TABLES.map((t) => [t.table, t.rows]));

  const maria = await verifyMariaDb(seedSql);
  const sqlite = await verifySqlite(seedSql);

  assertIdenticalCounts('MariaDB tpl_sample_library', maria.templateCounts, expected);
  assertIdenticalCounts('MariaDB fresh load', maria.freshCounts, expected);
  assertIdenticalCounts('SQLite sql.js', sqlite.counts, expected);
  assertIdenticalCounts('MariaDB vs SQLite', maria.freshCounts, sqlite.counts);

  const totalRows = [...expected.values()].reduce((acc, n) => acc + n, 0);
  console.log(
    `\nALL SEED VERIFICATIONS PASSED (${expected.size} tables, ${totalRows} rows, ${maria.fkCount} FKs identical across MariaDB and SQLite).`,
  );
}

main().catch((err) => {
  console.error('verify-seeds failed:', err);
  process.exit(1);
});
