import type { AppSettings, IsolationLevel, PersistedStateV1 } from '../types/state';

export const STORAGE_KEY = 'sql-scratchpad:v1';
export const MAX_HISTORY_ENTRIES = 200;

export function createDefaultSettings(): AppSettings {
  return {
    stopOnError: true,
    safeUpdates: false,
    onlyFullGroupBy: false,
    strict: true,
    isolation: 'REPEATABLE READ',
    autocommit: true,
    theme: 'light',
  };
}

export function loadPersistedState(storage: Storage | null = safeLocalStorage()): PersistedStateV1 | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedStateV1>;
    if (!parsed || typeof parsed !== 'object') return null;

    const defaults = createDefaultSettings();
    const settings: AppSettings = {
      stopOnError: typeof parsed.settings?.stopOnError === 'boolean' ? parsed.settings.stopOnError : defaults.stopOnError,
      safeUpdates: typeof parsed.settings?.safeUpdates === 'boolean' ? parsed.settings.safeUpdates : defaults.safeUpdates,
      onlyFullGroupBy:
        typeof parsed.settings?.onlyFullGroupBy === 'boolean'
          ? parsed.settings.onlyFullGroupBy
          : defaults.onlyFullGroupBy,
      strict: typeof parsed.settings?.strict === 'boolean' ? parsed.settings.strict : defaults.strict,
      isolation: isIsolationLevel(parsed.settings?.isolation)
        ? parsed.settings.isolation
        : defaults.isolation,
      autocommit: typeof parsed.settings?.autocommit === 'boolean' ? parsed.settings.autocommit : defaults.autocommit,
      theme: parsed.settings?.theme === 'dark' ? 'dark' : 'light',
    };

    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter(
          (t): t is PersistedStateV1['tabs'][number] =>
            !!t &&
            typeof t.id === 'string' &&
            typeof t.title === 'string' &&
            typeof t.sql === 'string' &&
            typeof t.cursor === 'number',
        )
      : [];

    const history = Array.isArray(parsed.history)
      ? parsed.history
          .filter(
            (h): h is PersistedStateV1['history'][number] =>
              !!h &&
              typeof h.ts === 'string' &&
              (h.engine === 'mariadb' || h.engine === 'sqlite') &&
              typeof h.dataset === 'string' &&
              typeof h.sql === 'string' &&
              typeof h.summary === 'string',
          )
          .slice(0, MAX_HISTORY_ENTRIES)
      : [];

    return {
      wsId: typeof parsed.wsId === 'string' && parsed.wsId.length > 0 ? parsed.wsId : null,
      engine: parsed.engine === 'sqlite' ? 'sqlite' : 'mariadb',
      dataset:
        typeof parsed.dataset === 'string' && parsed.dataset.length > 0
          ? parsed.dataset
          : 'sample-library',
      tabs,
      activeTab: typeof parsed.activeTab === 'string' ? parsed.activeTab : (tabs[0]?.id ?? ''),
      history,
      settings,
    };
  } catch {
    return null;
  }
}

export function savePersistedState(
  state: PersistedStateV1,
  storage: Storage | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    const trimmed: PersistedStateV1 = {
      ...state,
      history: state.history.slice(0, MAX_HISTORY_ENTRIES),
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore quota errors
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isIsolationLevel(value: unknown): value is IsolationLevel {
  return (
    value === 'READ UNCOMMITTED' ||
    value === 'READ COMMITTED' ||
    value === 'REPEATABLE READ' ||
    value === 'SERIALIZABLE'
  );
}

export function buildSafeUpdatesSql(enabled: boolean): string {
  return `SET SESSION sql_safe_updates = ${enabled ? 1 : 0};`;
}

export function buildOnlyFullGroupBySql(enabled: boolean): string {
  if (enabled) {
    return "SET SESSION sql_mode = IF(FIND_IN_SET('ONLY_FULL_GROUP_BY', @@sql_mode) > 0, @@sql_mode, CONCAT_WS(',', NULLIF(@@sql_mode, ''), 'ONLY_FULL_GROUP_BY'));";
  }
  return "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@sql_mode, ','), ',ONLY_FULL_GROUP_BY,', ','));";
}

export function buildStrictModeSql(enabled: boolean): string {
  if (enabled) {
    return "SET SESSION sql_mode = IF(FIND_IN_SET('STRICT_TRANS_TABLES', @@sql_mode) > 0, @@sql_mode, CONCAT_WS(',', NULLIF(@@sql_mode, ''), 'STRICT_TRANS_TABLES'));";
  }
  return "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@sql_mode, ','), ',STRICT_TRANS_TABLES,', ','));";
}

export function buildIsolationSql(level: IsolationLevel): string {
  return `SET SESSION TRANSACTION ISOLATION LEVEL ${level};`;
}

export function buildAutocommitSql(enabled: boolean): string {
  return `SET autocommit = ${enabled ? 1 : 0};`;
}
