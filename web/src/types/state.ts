import type { EngineId } from '@sql-scratchpad/shared';

export type IsolationLevel =
  'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface EditorTab {
  id: string;
  title: string;
  sql: string;
  cursor: number;
}

export interface HistoryEntry {
  ts: string;
  engine: EngineId;
  dataset: string;
  sql: string;
  summary: string;
}

export interface AppSettings {
  stopOnError: boolean;
  safeUpdates: boolean;
  onlyFullGroupBy: boolean;
  strict: boolean;
  isolation: IsolationLevel;
  autocommit: boolean;
  theme: 'light' | 'dark';
}

export interface PersistedStateV1 {
  wsId: string | null;
  engine: EngineId;
  dataset: string;
  tabs: EditorTab[];
  activeTab: string;
  history: HistoryEntry[];
  settings: AppSettings;
}

export interface StatusLogEntry {
  id: number;
  timestamp: string;
  level: 'info' | 'error' | 'warning' | 'notice';
  message: string;
}
