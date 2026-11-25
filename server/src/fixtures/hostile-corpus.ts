/**
 * Hostile SQL test corpus fixtures for M8-lite security verification.
 * All payloads are synthetic and contain zero private/course data.
 */

export const LOG_CANARY_TOKEN = 'HOSTILE_CANARY_9911_DO_NOT_LOG';

export const PRIVILEGE_ESCALATION_CASES: ReadonlyArray<{
  id: string;
  label: string;
  sql: string;
  directSql?: string;
}> = [
  {
    id: 'grant',
    label: 'GRANT ALL ON *.*',
    sql: `GRANT ALL PRIVILEGES ON *.* TO CURRENT_USER(); -- ${LOG_CANARY_TOKEN}`,
  },
  {
    id: 'revoke',
    label: 'REVOKE ALL ON *.*',
    sql: `REVOKE ALL PRIVILEGES ON *.* FROM CURRENT_USER(); -- ${LOG_CANARY_TOKEN}`,
  },
  {
    id: 'create-user',
    label: 'CREATE USER',
    sql: `CREATE USER 'evil_actor'@'%' IDENTIFIED BY '${LOG_CANARY_TOKEN}';`,
  },
  {
    id: 'set-global',
    label: 'SET GLOBAL max_connections',
    sql: `SET GLOBAL max_connections = 9999; -- ${LOG_CANARY_TOKEN}`,
  },
  {
    id: 'set-password',
    label: 'SET PASSWORD',
    sql: `SET PASSWORD FOR 'root'@'localhost' = PASSWORD('${LOG_CANARY_TOKEN}');`,
  },
  {
    id: 'shutdown',
    label: 'SHUTDOWN',
    sql: `SHUTDOWN; -- ${LOG_CANARY_TOKEN}`,
  },
  {
    id: 'create-function-soname',
    label: 'CREATE FUNCTION ... SONAME',
    sql: `CREATE FUNCTION evil_udf RETURNS INTEGER SONAME 'evil_udf.so'; -- ${LOG_CANARY_TOKEN}`,
  },
  {
    id: 'install-plugin',
    label: 'INSTALL PLUGIN',
    sql: `INSTALL PLUGIN evil_plugin SONAME 'evil_plugin.so'; -- ${LOG_CANARY_TOKEN}`,
  },
];

export const FILE_IO_CASES: ReadonlyArray<{
  id: string;
  label: string;
  sql: string;
}> = [
  {
    id: 'load-data-infile',
    label: 'LOAD DATA INFILE',
    sql: `LOAD DATA INFILE '/etc/passwd' INTO TABLE Books; -- ${LOG_CANARY_TOKEN}`,
  },
  {
    id: 'load-data-local-infile',
    label: 'LOAD DATA LOCAL INFILE',
    sql: `LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE Books; -- ${LOG_CANARY_TOKEN}`,
  },
  {
    id: 'into-outfile',
    label: 'SELECT ... INTO OUTFILE',
    sql: `SELECT '${LOG_CANARY_TOKEN}' INTO OUTFILE '/tmp/hostile_outfile.txt';`,
  },
  {
    id: 'into-dumpfile',
    label: 'SELECT ... INTO DUMPFILE',
    sql: `SELECT '${LOG_CANARY_TOKEN}' INTO DUMPFILE '/tmp/hostile_dumpfile.bin';`,
  },
];

export const RECURSIVE_CTE_BOMB_SQL = `
WITH RECURSIVE bomb(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM bomb
)
SELECT COUNT(*) FROM bomb; -- ${LOG_CANARY_TOKEN}
`.trim();

export const BENCHMARK_BOMB_SQL = `SELECT BENCHMARK(1000000000, SHA2('${LOG_CANARY_TOKEN}', 512));`;

export const DELIMITER_ABUSE_SQL = [
  'DELIMITER //',
  'DELIMITER $$$',
  'DELIMITER ;;;',
  'DELIMITER //',
  `GRANT ALL ON *.* TO CURRENT_USER()//`,
  'DELIMITER ;',
  'SELECT 1;',
].join('\n');

export function buildDeeplyNestedCommentsSql(depth = 2000): string {
  const repeatedBlocks = '/* nested /* comment */ '.repeat(depth);
  return `${repeatedBlocks}\n/*!50000 GRANT ALL ON *.* TO CURRENT_USER() */;`;
}

export function buildBulkRowsImportSql(rowCount = 20_000): string {
  const lines: string[] = [
    'CREATE TABLE big_items (id INT PRIMARY KEY, grp INT NOT NULL, payload VARCHAR(40) NOT NULL);',
  ];
  const chunkSize = 200;
  for (let start = 1; start <= rowCount; start += chunkSize) {
    const end = Math.min(rowCount, start + chunkSize - 1);
    const tuples: string[] = [];
    for (let id = start; id <= end; id += 1) {
      tuples.push(`(${id},${id % 50},'item_${id}')`);
    }
    lines.push(`INSERT INTO big_items (id, grp, payload) VALUES ${tuples.join(',')};`);
  }
  return lines.join('\n');
}

export function build60001StatementsSql(): string {
  return 'SELECT 1;\n'.repeat(60_001);
}

export function build5MbStringLiteralSql(): string {
  const payload = 'A'.repeat(5 * 1024 * 1024);
  return `SELECT LENGTH('${payload}') AS len;`;
}

export function buildExecSleepLoopSql(count = 100): string {
  return 'SELECT SLEEP(4);\n'.repeat(count);
}
