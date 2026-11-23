export type EngineId = 'mariadb';
export type SessionId = 'A' | 'B';

export interface ColumnMeta {
  name: string;
  type: string;
}

export interface StatementWarning {
  level: string;
  code: number;
  message: string;
}

export interface StatementError {
  code: string;
  errno?: number;
  sqlState?: string;
  message: string;
}

export interface StatementResult {
  index: number;
  sql: string;
  startLine: number;
  kind: 'rows' | 'ok' | 'error';
  columns?: ColumnMeta[];
  rows?: unknown[][];
  truncated?: boolean;
  rowCount?: number;
  affectedRows?: number;
  insertId?: number | string;
  warnings?: StatementWarning[];
  error?: StatementError;
  durationMs: number;
}

export interface ExecRequest {
  sql: string;
  session: SessionId;
  stopOnError: boolean;
}

export interface ExecResponse {
  results: StatementResult[];
  txOpen: boolean;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  key: 'PRI' | 'UNI' | 'MUL' | '';
  default: string | null;
  extra: string;
}

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface SchemaForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
  triggers: string[];
}

export interface SchemaView {
  name: string;
  definition?: string;
}

export interface SchemaTree {
  database: string;
  engine: EngineId;
  tables: SchemaTable[];
  views: SchemaView[];
}

export interface EngineAdapter {
  id: EngineId;
  open(datasetId: string): Promise<void>;
  exec(req: ExecRequest): Promise<ExecResponse>;
  schema(): Promise<SchemaTree>;
  reset(datasetId: string): Promise<void>;
  close(): Promise<void>;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'maintenance';
  db: 'ok' | 'error';
  version: string;
}

export interface DatasetMeta {
  id: string;
  title: string;
  description: string;
  tables: string[];
  engines: EngineId[];
}

export interface CreateWorkspaceRequest {
  dataset: string;
}

export interface CreateWorkspaceResponse {
  wsId: string;
  database: string;
  expiresAt: string;
}

export interface ResetWorkspaceRequest {
  dataset: string;
}

export interface ResetWorkspaceResponse {
  database: string;
}

export interface OkResponse {
  ok: true;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export type ImportMode = 'fresh' | 'append';

export interface ImportRequest {
  sql: string;
  mode: ImportMode;
}

export interface ImportSkippedStatement {
  index: number;
  startLine: number;
  reason: string;
  snippet: string;
}

export interface ImportRewrittenStatement {
  index: number;
  startLine: number;
  reason: string;
  snippet: string;
}

export interface ImportErrorDetail {
  index: number;
  startLine: number;
  code: string;
  errno?: number;
  sqlState?: string;
  message: string;
  alreadyApplied: boolean;
  hint?: string;
}

export interface ImportResponse {
  ok: boolean;
  mode: ImportMode;
  totalStatements: number;
  statementsRun: number;
  statementsOk: number;
  skippedCount: number;
  skipped: ImportSkippedStatement[];
  skippedTruncated?: boolean;
  rewrittenCount: number;
  rewritten: ImportRewrittenStatement[];
  rewrittenTruncated?: boolean;
  warningsCount: number;
  durationMs: number;
  tablesCreated: string[];
  error?: ImportErrorDetail;
  note?: string;
}
