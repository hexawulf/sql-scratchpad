<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { Pane, Splitpanes } from 'splitpanes';
import type {
  DatasetMeta,
  ExecResponse,
  ImportMode,
  ImportResponse,
  SchemaTree as SchemaTreeData,
  StatementResult,
} from '@sql-scratchpad/shared';
import { MariaDbAdapter, WorkspaceExpiredError } from './engines/mariadb';
import type {
  AppSettings,
  EditorTab,
  HistoryEntry,
  IsolationLevel,
  StatusLogEntry,
} from './types/state';
import {
  MAX_HISTORY_ENTRIES,
  buildAutocommitSql,
  buildIsolationSql,
  buildOnlyFullGroupBySql,
  buildSafeUpdatesSql,
  buildStrictModeSql,
  createDefaultSettings,
  loadPersistedState,
  savePersistedState,
} from './utils/storage';
import { containsDdlStatement } from './utils/sql-statement';
import {
  formatDurationSeconds,
  formatNoticeLine,
  formatStatementStatusLines,
} from './utils/status-format';
import { openSqlFile, saveSqlFile } from './utils/sql-file';
import SchemaTree from './components/SchemaTree.vue';
import SqlEditor from './components/SqlEditor.vue';
import ResultGrid from './components/ResultGrid.vue';
import MessagesPanel, { type ImportSummaryRecord } from './components/MessagesPanel.vue';
import StatusLog from './components/StatusLog.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import TabBar from './components/TabBar.vue';
import SettingsDrawer from './components/SettingsDrawer.vue';
import AboutModal from './components/AboutModal.vue';
import ImportModal from './components/ImportModal.vue';

function makeTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const persisted = loadPersistedState();

const adapter = new MariaDbAdapter({
  initialWsId: persisted?.wsId ?? null,
});

const DEFAULT_STARTER_SQL = '-- Pick a dataset or import your own .sql file to get started\n';

const datasets = ref<DatasetMeta[]>([]);
const currentDataset = ref<string>(persisted?.dataset ?? 'empty');
const wsId = ref<string | null>(persisted?.wsId ?? null);
const schema = ref<SchemaTreeData | null>(null);
const schemaLoading = ref(false);
const showWelcome = ref<boolean>(!persisted);

const settings = reactive<AppSettings>(persisted?.settings ?? createDefaultSettings());

const initialTabs: EditorTab[] =
  persisted && persisted.tabs.length > 0
    ? persisted.tabs
    : [
        {
          id: makeTabId(),
          title: 'query_1.sql',
          sql: DEFAULT_STARTER_SQL,
          cursor: 0,
        },
      ];

const tabs = ref<EditorTab[]>(initialTabs);
const activeTabId = ref<string>(
  persisted?.activeTab && initialTabs.some((t) => t.id === persisted.activeTab)
    ? persisted.activeTab
    : initialTabs[0]!.id,
);

const historyEntries = ref<HistoryEntry[]>(persisted?.history ?? []);
const statusEntries = ref<StatusLogEntry[]>([]);
let nextStatusId = 1;

const sidebarTab = ref<'databases' | 'exercises'>('databases');
const editorTab = ref<'query' | 'history'>('query');
const resultTab = ref<'grid' | 'messages'>('grid');
const settingsOpen = ref(false);
const aboutOpen = ref(false);

const importFileInputRef = ref<HTMLInputElement | null>(null);
const pendingImportFile = ref<File | null>(null);
const importModalOpen = ref(false);
const importing = ref(false);
const importModalError = ref<string | null>(null);
const lastImportSummary = ref<ImportSummaryRecord | null>(null);

const running = ref(false);
const txOpen = ref(false);
const errorLine = ref<number | null>(null);
const bannerNotice = ref<string | null>(null);
const maintenanceMode = ref(false);

const lastResults = ref<StatementResult[]>([]);
const selectedResultIdx = ref<number>(0);

const editorRef = ref<InstanceType<typeof SqlEditor> | null>(null);

const activeTab = computed<EditorTab>(() => {
  return tabs.value.find((t) => t.id === activeTabId.value) ?? tabs.value[0]!;
});

const rowResultSets = computed(() =>
  lastResults.value
    .map((res, idx) => ({ res, idx }))
    .filter((item) => item.res.kind === 'rows'),
);

const activeResult = computed<StatementResult | null>(() => {
  if (rowResultSets.value.length === 0) return null;
  const matched = rowResultSets.value.find((item) => item.idx === selectedResultIdx.value);
  return (matched ?? rowResultSets.value[rowResultSets.value.length - 1])?.res ?? null;
});

function pushStatus(entry: Omit<StatusLogEntry, 'id'>): void {
  statusEntries.value.push({ id: nextStatusId++, ...entry });
}

function applyTheme(theme: 'light' | 'dark'): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
}

watch(
  () => settings.theme,
  (theme) => applyTheme(theme),
  { immediate: true },
);

function persistNow(): void {
  savePersistedState({
    wsId: wsId.value,
    engine: 'mariadb',
    dataset: currentDataset.value,
    tabs: tabs.value,
    activeTab: activeTabId.value,
    history: historyEntries.value,
    settings: { ...settings },
  });
}

watch([wsId, currentDataset, tabs, activeTabId, historyEntries, settings], persistNow, {
  deep: true,
});

async function recreateWorkspaceWithNotice(): Promise<void> {
  await adapter.open(currentDataset.value);
  wsId.value = adapter.getWorkspaceId();
  const msg = `Workspace expired — fresh copy of ${currentDataset.value} loaded`;
  bannerNotice.value = msg;
  pushStatus(formatNoticeLine(msg, 'notice'));
  await refreshSchema(false);
}

async function refreshSchema(allowAutoRecreate = true): Promise<void> {
  schemaLoading.value = true;
  try {
    schema.value = await adapter.schema();
  } catch (err) {
    if (err instanceof WorkspaceExpiredError && allowAutoRecreate) {
      await recreateWorkspaceWithNotice();
      return;
    }
    pushStatus(formatNoticeLine(`Failed to load schema: ${(err as Error).message}`, 'error'));
  } finally {
    schemaLoading.value = false;
  }
}

async function bootstrap(): Promise<void> {
  try {
    const health = await adapter.fetchHealth();
    if (health.status === 'maintenance') {
      maintenanceMode.value = true;
      pushStatus(
        formatNoticeLine(
          'SQL Scratchpad is currently in maintenance mode. Please try again shortly.',
          'error',
        ),
      );
      return;
    }
  } catch {
    // Health check failure falls through to normal dataset/workspace error handling
  }

  try {
    datasets.value = await adapter.fetchDatasets();
    if (
      datasets.value.length > 0 &&
      !datasets.value.some((d) => d.id === currentDataset.value)
    ) {
      currentDataset.value = datasets.value.some((d) => d.id === 'empty')
        ? 'empty'
        : datasets.value[0]!.id;
    }
  } catch (err) {
    pushStatus(formatNoticeLine(`Failed to load datasets: ${(err as Error).message}`, 'error'));
  }

  if (wsId.value) {
    adapter.attach(wsId.value);
    try {
      schemaLoading.value = true;
      schema.value = await adapter.schema();
      schemaLoading.value = false;
      pushStatus(formatNoticeLine(`Connected to workspace ${schema.value.database}.`, 'notice'));
      return;
    } catch (err) {
      schemaLoading.value = false;
      if (err instanceof WorkspaceExpiredError) {
        await recreateWorkspaceWithNotice();
        return;
      }
      pushStatus(formatNoticeLine(`Reconnect error: ${(err as Error).message}`, 'error'));
    }
  }

  try {
    await adapter.open(currentDataset.value);
    wsId.value = adapter.getWorkspaceId();
    await refreshSchema(false);
    pushStatus(
      formatNoticeLine(
        `Workspace ready (${schema.value?.database ?? currentDataset.value}).`,
        'notice',
      ),
    );
  } catch (err) {
    pushStatus(formatNoticeLine(`Workspace creation failed: ${(err as Error).message}`, 'error'));
  }
}

async function executeSql(
  sqlText: string,
  options: { lineOffset?: number; recordHistory?: boolean; echoSqlInStatus?: boolean } = {},
): Promise<ExecResponse | null> {
  const trimmed = sqlText.trim();
  if (!trimmed || running.value) return null;

  const lineOffset = options.lineOffset ?? 0;
  running.value = true;
  errorLine.value = null;

  if (options.echoSqlInStatus) {
    pushStatus(formatNoticeLine(`Session toggle: ${trimmed}`, 'notice'));
  }

  const runOnce = async (): Promise<ExecResponse> => {
    return adapter.exec({
      sql: trimmed,
      session: 'A',
      stopOnError: settings.stopOnError,
    });
  };

  try {
    let response: ExecResponse;
    try {
      response = await runOnce();
    } catch (err) {
      if (err instanceof WorkspaceExpiredError) {
        await recreateWorkspaceWithNotice();
        response = await runOnce();
      } else {
        throw err;
      }
    }

    txOpen.value = response.txOpen;
    lastResults.value = response.results;
    showWelcome.value = false;

    for (const res of response.results) {
      for (const line of formatStatementStatusLines(res)) {
        pushStatus(line);
      }
    }

    const firstErr = response.results.find((r) => r.kind === 'error');
    if (firstErr) {
      errorLine.value = Math.max(1, firstErr.startLine + lineOffset);
    }

    const rowSets = response.results
      .map((res, idx) => ({ res, idx }))
      .filter((item) => item.res.kind === 'rows');
    if (rowSets.length > 0) {
      selectedResultIdx.value = rowSets[rowSets.length - 1]!.idx;
      resultTab.value = 'grid';
    } else if (firstErr) {
      resultTab.value = 'messages';
    }

    if (options.recordHistory !== false) {
      const summary = summarizeResults(response.results);
      const entry: HistoryEntry = {
        ts: new Date().toISOString(),
        engine: 'mariadb',
        dataset: currentDataset.value,
        sql: trimmed,
        summary,
      };
      historyEntries.value = [entry, ...historyEntries.value].slice(0, MAX_HISTORY_ENTRIES);
    }

    if (containsDdlStatement(response.results)) {
      await refreshSchema(false);
    }

    return response;
  } catch (err) {
    pushStatus(formatNoticeLine(`Execution failed: ${(err as Error).message}`, 'error'));
    return null;
  } finally {
    running.value = false;
  }
}

function summarizeResults(results: StatementResult[]): string {
  if (results.length === 0) return 'No statements';
  const errors = results.filter((r) => r.kind === 'error').length;
  if (errors > 0) {
    return `${results.length} stmt(s), ${errors} error(s)`;
  }
  const last = results[results.length - 1]!;
  if (last.kind === 'rows') {
    return `${results.length} stmt(s), ${last.rowCount ?? last.rows?.length ?? 0} row(s)`;
  }
  return `${results.length} stmt(s), ${last.affectedRows ?? 0} affected`;
}

function handleRunScriptClick(): void {
  const payload = editorRef.value?.getRunPayload() ?? { sql: activeTab.value.sql, lineOffset: 0 };
  void executeSql(payload.sql, { lineOffset: payload.lineOffset });
}

function handleRunStatementClick(): void {
  const payload = editorRef.value?.getStatementPayload();
  if (!payload) return;
  void executeSql(payload.sql, { lineOffset: payload.startLine - 1 });
}

async function handleStopClick(): Promise<void> {
  if (!running.value) return;
  try {
    await adapter.kill('A');
    pushStatus(formatNoticeLine('Sent KILL QUERY to session A.', 'warning'));
  } catch (err) {
    pushStatus(formatNoticeLine(`Stop failed: ${(err as Error).message}`, 'error'));
  }
}

async function handleDatasetChange(newDataset: string): Promise<void> {
  currentDataset.value = newDataset;
  showWelcome.value = false;
  await resetWorkspaceTo(newDataset);
}

async function handleWelcomePickEmpty(): Promise<void> {
  showWelcome.value = false;
  if (currentDataset.value !== 'empty') {
    currentDataset.value = 'empty';
    await resetWorkspaceTo('empty');
  }
}

async function handleWelcomePickSample(): Promise<void> {
  showWelcome.value = false;
  currentDataset.value = 'sample-library';
  if (activeTab.value.sql.trim() === '' || activeTab.value.sql === DEFAULT_STARTER_SQL) {
    activeTab.value.sql = '-- Explore the Sample: Library dataset\nSELECT * FROM Books;\n';
  }
  await resetWorkspaceTo('sample-library');
}

function triggerImportPicker(): void {
  if (running.value || importing.value) return;
  const input = importFileInputRef.value;
  if (!input) return;
  input.value = '';
  input.click();
}

function handleImportInputChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    handleImportFileSelected(file);
  }
}

function handleImportFileSelected(file: File): void {
  if (running.value || importing.value) return;
  pendingImportFile.value = file;
  importModalError.value = null;
  importModalOpen.value = true;
}

function handleCloseImportModal(): void {
  if (importing.value) return;
  importModalOpen.value = false;
  pendingImportFile.value = null;
  importModalError.value = null;
}

async function handleConfirmImport(mode: ImportMode): Promise<void> {
  const file = pendingImportFile.value;
  if (!file || importing.value || running.value) return;

  importing.value = true;
  running.value = true;
  importModalError.value = null;
  errorLine.value = null;

  try {
    const sqlText = await file.text();
    const runImportOnce = async (): Promise<ImportResponse> =>
      adapter.importSql({ sql: sqlText, mode });

    let response: ImportResponse;
    try {
      response = await runImportOnce();
    } catch (err) {
      if (err instanceof WorkspaceExpiredError) {
        await recreateWorkspaceWithNotice();
        response = await runImportOnce();
      } else {
        throw err;
      }
    }

    lastImportSummary.value = { fileName: file.name, response };
    showWelcome.value = false;
    resultTab.value = 'messages';
    txOpen.value = false;
    if (mode === 'fresh') {
      currentDataset.value = 'empty';
    }

    const dur = formatDurationSeconds(response.durationMs);
    const tablesNote =
      response.tablesCreated.length > 0
        ? ` Tables created: ${response.tablesCreated.join(', ')}.`
        : '';

    if (response.ok) {
      pushStatus(
        formatNoticeLine(
          `Imported ${file.name} (${mode}) in ${dur} second(s): ${response.statementsOk} OK, ${response.skippedCount} skipped, ${response.rewrittenCount} rewritten, ${response.warningsCount} warning(s).${tablesNote}`,
          'notice',
        ),
      );
    } else if (response.error) {
      const errCode =
        response.error.errno !== undefined ? `ERROR ${response.error.errno}` : response.error.code;
      const sqlState = response.error.sqlState ? ` (${response.error.sqlState})` : '';
      pushStatus(
        formatNoticeLine(
          `Import ${file.name} stopped at stmt #${response.error.index + 1} (line ${response.error.startLine}): ${errCode}${sqlState}: ${response.error.message}`,
          'error',
        ),
      );
      if (response.note) {
        pushStatus(formatNoticeLine(response.note, 'warning'));
      }
    }

    await refreshSchema(false);
    importModalOpen.value = false;
    pendingImportFile.value = null;
  } catch (err) {
    const msg = (err as Error).message || 'Import failed';
    importModalError.value = msg;
    pushStatus(formatNoticeLine(`Import failed (${file.name}): ${msg}`, 'error'));
  } finally {
    importing.value = false;
    running.value = false;
  }
}

async function resetWorkspaceTo(datasetId: string): Promise<void> {
  if (running.value) return;
  running.value = true;
  errorLine.value = null;
  try {
    try {
      await adapter.reset(datasetId);
    } catch (err) {
      if (err instanceof WorkspaceExpiredError) {
        await adapter.open(datasetId);
        wsId.value = adapter.getWorkspaceId();
      } else {
        throw err;
      }
    }
    txOpen.value = false;
    lastResults.value = [];
    lastImportSummary.value = null;
    await refreshSchema(false);
    pushStatus(formatNoticeLine(`Database reset to dataset "${datasetId}".`, 'notice'));
  } catch (err) {
    pushStatus(formatNoticeLine(`Reset failed: ${(err as Error).message}`, 'error'));
  } finally {
    running.value = false;
  }
}

function handleUpdateSql(nextSql: string): void {
  activeTab.value.sql = nextSql;
  if (errorLine.value !== null) {
    errorLine.value = null;
  }
}

function handleUpdateCursor(offset: number): void {
  activeTab.value.cursor = offset;
}

function handleAddTab(): void {
  const nextNum = tabs.value.length + 1;
  const tab: EditorTab = {
    id: makeTabId(),
    title: `query_${nextNum}.sql`,
    sql: '',
    cursor: 0,
  };
  tabs.value.push(tab);
  activeTabId.value = tab.id;
  editorTab.value = 'query';
}

function handleCloseTab(id: string): void {
  if (tabs.value.length <= 1) return;
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.value.splice(idx, 1);
  if (activeTabId.value === id) {
    activeTabId.value = tabs.value[Math.max(0, idx - 1)]!.id;
  }
}

function handleRenameTab(id: string, title: string): void {
  const target = tabs.value.find((t) => t.id === id);
  if (target) target.title = title;
}

function handleLoadHistory(entry: HistoryEntry): void {
  activeTab.value.sql = entry.sql;
  activeTab.value.cursor = 0;
  editorTab.value = 'query';
}

function handlePreviewTable(tableName: string): void {
  const sqlText = `SELECT * FROM \`${tableName.replace(/`/g, '``')}\`;`;
  activeTab.value.sql = sqlText;
  editorTab.value = 'query';
  void executeSql(sqlText);
}

async function handleOpenFile(): Promise<void> {
  const file = await openSqlFile();
  if (!file) return;
  const tab: EditorTab = {
    id: makeTabId(),
    title: file.name,
    sql: file.content,
    cursor: 0,
  };
  tabs.value.push(tab);
  activeTabId.value = tab.id;
  editorTab.value = 'query';
  pushStatus(formatNoticeLine(`Opened ${file.name}.`, 'notice'));
}

async function handleSaveFile(): Promise<void> {
  const ok = await saveSqlFile(activeTab.value.title, activeTab.value.sql);
  if (ok) {
    pushStatus(formatNoticeLine(`Saved ${activeTab.value.title}.`, 'notice'));
  }
}

async function applySessionToggle(sqlText: string, onSuccess: () => void): Promise<void> {
  const res = await executeSql(sqlText, { recordHistory: false, echoSqlInStatus: true });
  if (res && !res.results.some((r) => r.kind === 'error')) {
    onSuccess();
  }
}

function handleToggleSafeUpdates(val: boolean): void {
  void applySessionToggle(buildSafeUpdatesSql(val), () => {
    settings.safeUpdates = val;
  });
}

function handleToggleOnlyFullGroupBy(val: boolean): void {
  void applySessionToggle(buildOnlyFullGroupBySql(val), () => {
    settings.onlyFullGroupBy = val;
  });
}

function handleToggleStrict(val: boolean): void {
  void applySessionToggle(buildStrictModeSql(val), () => {
    settings.strict = val;
  });
}

function handleChangeIsolation(level: IsolationLevel): void {
  void applySessionToggle(buildIsolationSql(level), () => {
    settings.isolation = level;
  });
}

function handleToggleAutocommit(val: boolean): void {
  void applySessionToggle(buildAutocommitSql(val), () => {
    settings.autocommit = val;
  });
}

function formatResultLabel(res: StatementResult, pos: number, total: number): string {
  const firstLine = res.sql.replace(/\s+/g, ' ').trim();
  const snippet = firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine;
  return `Result ${pos + 1} of ${total} · ${snippet}`;
}

onMounted(() => {
  void bootstrap();
});
</script>

<template>
  <div class="app-root">
    <!-- Top Toolbar -->
    <header class="toolbar" role="toolbar" aria-label="SQL Scratchpad toolbar">
      <div class="toolbar-group">
        <span class="brand">SQL Scratchpad</span>

        <label class="select-wrap" title="SQL Engine">
          <span class="sr-only">Engine</span>
          <select aria-label="Engine" class="tb-select" data-testid="engine-select">
            <option value="mariadb">MariaDB 11.4</option>
            <option value="sqlite" disabled>SQLite (M6)</option>
          </select>
        </label>

        <label class="select-wrap" title="Dataset">
          <span class="sr-only">Dataset</span>
          <select
            aria-label="Dataset"
            class="tb-select"
            data-testid="dataset-select"
            :value="currentDataset"
            :disabled="running"
            @change="handleDatasetChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-if="datasets.length === 0" :value="currentDataset">
              {{ currentDataset }}
            </option>
            <option v-for="ds in datasets" :key="ds.id" :value="ds.id">
              {{ ds.id }} — {{ ds.title }}
            </option>
          </select>
        </label>
      </div>

      <div class="toolbar-group">
        <button
          type="button"
          class="tb-btn primary"
          title="Run selection or whole script (F9 / Ctrl+Shift+Enter)"
          data-testid="run-btn"
          :disabled="running"
          @click="handleRunScriptClick"
        >
          ▶ Run (F9)
        </button>
        <button
          type="button"
          class="tb-btn"
          title="Run statement under cursor (Ctrl+Enter)"
          data-testid="run-stmt-btn"
          :disabled="running"
          @click="handleRunStatementClick"
        >
          ▶| Stmt
        </button>
        <button
          type="button"
          class="tb-btn danger"
          title="Stop running query (Esc)"
          data-testid="stop-btn"
          :disabled="!running"
          @click="handleStopClick"
        >
          ■ Stop
        </button>
        <button
          type="button"
          class="tb-btn"
          title="Reset workspace database"
          data-testid="reset-btn"
          :disabled="running"
          @click="resetWorkspaceTo(currentDataset)"
        >
          ↺ Reset DB
        </button>
        <button
          type="button"
          class="tb-btn"
          title="Format SQL (Ctrl+Shift+F)"
          @click="editorRef?.formatDocument()"
        >
          Format
        </button>
      </div>

      <div class="toolbar-group toolbar-right">
        <span v-if="txOpen" class="tx-badge" data-testid="tx-badge">
          ● Transaction open (A)
        </span>

        <button
          type="button"
          class="tb-btn"
          title="About SQL Scratchpad"
          data-testid="about-btn"
          @click="aboutOpen = true"
        >
          About
        </button>
        <button type="button" class="tb-btn" title="Open .sql file in editor tab" @click="handleOpenFile">
          Open
        </button>
        <button
          type="button"
          class="tb-btn"
          title="Import .sql file into workspace database"
          data-testid="import-btn"
          :disabled="running || importing"
          @click="triggerImportPicker"
        >
          Import .sql…
        </button>
        <button type="button" class="tb-btn" title="Save .sql file" @click="handleSaveFile">
          Save
        </button>
        <button
          type="button"
          class="tb-btn"
          title="Toggle light/dark theme"
          data-testid="theme-btn"
          @click="settings.theme = settings.theme === 'dark' ? 'light' : 'dark'"
        >
          {{ settings.theme === 'dark' ? '☀ Light' : '☾ Dark' }}
        </button>
        <button
          type="button"
          class="tb-btn"
          title="Session settings"
          data-testid="settings-btn"
          @click="settingsOpen = true"
        >
          ⚙ Session
        </button>
      </div>
    </header>

    <div
      v-if="maintenanceMode"
      class="maintenance-banner"
      role="alert"
      data-testid="maintenance-banner"
    >
      <span>
        SQL Scratchpad is temporarily down for maintenance. Your tabs and query history remain saved
        in this browser.
      </span>
    </div>

    <div v-if="bannerNotice" class="notice-banner" role="status" data-testid="expired-banner">
      <span>{{ bannerNotice }}</span>
      <button type="button" class="banner-close" @click="bannerNotice = null">×</button>
    </div>

    <!-- Main Workspace -->
    <main class="workspace-area">
      <Splitpanes>
        <!-- Left Sidebar -->
        <Pane :size="20" :min-size="14" :max-size="38">
          <div class="sidebar-pane">
            <div class="sidebar-content">
              <SchemaTree
                v-if="sidebarTab === 'databases'"
                :schema="schema"
                :loading="schemaLoading"
                @refresh="refreshSchema()"
                @insert-ident="(ident) => editorRef?.insertText(ident)"
                @preview-table="handlePreviewTable"
                @drop-sql-file="handleImportFileSelected"
              />
              <div v-else class="exercises-placeholder">
                <p><strong>Exercises</strong></p>
                <p>Exercise library and automatic checking arrive in M5.</p>
              </div>
            </div>
            <div class="sidebar-switcher" role="tablist">
              <button
                type="button"
                class="sub-tab"
                :class="{ active: sidebarTab === 'databases' }"
                role="tab"
                :aria-selected="sidebarTab === 'databases'"
                @click="sidebarTab = 'databases'"
              >
                Databases
              </button>
              <button
                type="button"
                class="sub-tab"
                :class="{ active: sidebarTab === 'exercises' }"
                role="tab"
                :aria-selected="sidebarTab === 'exercises'"
                @click="sidebarTab = 'exercises'"
              >
                Exercises
              </button>
            </div>
          </div>
        </Pane>

        <!-- Right Main Stack -->
        <Pane :size="80" :min-size="50">
          <Splitpanes horizontal>
            <!-- Top: Query | History -->
            <Pane :size="44" :min-size="20">
              <div class="pane-shell">
                <div class="pane-tabs" role="tablist">
                  <button
                    type="button"
                    class="sub-tab"
                    :class="{ active: editorTab === 'query' }"
                    role="tab"
                    :aria-selected="editorTab === 'query'"
                    @click="editorTab = 'query'"
                  >
                    Query
                  </button>
                  <button
                    type="button"
                    class="sub-tab"
                    :class="{ active: editorTab === 'history' }"
                    role="tab"
                    :aria-selected="editorTab === 'history'"
                    data-testid="history-tab-btn"
                    @click="editorTab = 'history'"
                  >
                    History ({{ historyEntries.length }})
                  </button>
                </div>
                <div class="pane-body">
                  <SqlEditor
                    v-show="editorTab === 'query'"
                    ref="editorRef"
                    :model-value="activeTab.sql"
                    :cursor="activeTab.cursor"
                    :schema="schema"
                    :error-line="errorLine"
                    :theme="settings.theme"
                    :running="running"
                    @update:model-value="handleUpdateSql"
                    @update:cursor="handleUpdateCursor"
                    @run-script="(s, off) => executeSql(s, { lineOffset: off })"
                    @run-statement="(s, line) => executeSql(s, { lineOffset: line - 1 })"
                    @stop="handleStopClick"
                  />
                  <HistoryPanel
                    v-if="editorTab === 'history'"
                    :entries="historyEntries"
                    @load="handleLoadHistory"
                    @clear="historyEntries = []"
                  />
                </div>
              </div>
            </Pane>

            <!-- Middle: Grid view | Messages -->
            <Pane :size="38" :min-size="18">
              <div class="pane-shell">
                <div class="pane-tabs result-header-bar">
                  <div class="tab-group" role="tablist">
                    <button
                      type="button"
                      class="sub-tab"
                      :class="{ active: resultTab === 'grid' }"
                      role="tab"
                      :aria-selected="resultTab === 'grid'"
                      @click="resultTab = 'grid'"
                    >
                      Grid view
                    </button>
                    <button
                      type="button"
                      class="sub-tab"
                      :class="{ active: resultTab === 'messages' }"
                      role="tab"
                      :aria-selected="resultTab === 'messages'"
                      @click="resultTab = 'messages'"
                    >
                      Messages ({{ lastResults.length + (lastImportSummary ? 1 : 0) }})
                    </button>
                  </div>

                  <div v-if="rowResultSets.length > 1" class="result-switcher">
                    <select
                      aria-label="Result set"
                      class="tb-select"
                      data-testid="result-switcher"
                      :value="selectedResultIdx"
                      @change="selectedResultIdx = Number(($event.target as HTMLSelectElement).value)"
                    >
                      <option
                        v-for="(item, pos) in rowResultSets"
                        :key="item.idx"
                        :value="item.idx"
                      >
                        {{ formatResultLabel(item.res, pos, rowResultSets.length) }}
                      </option>
                    </select>
                  </div>
                </div>
                <div class="pane-body">
                  <div
                    v-if="showWelcome && resultTab === 'grid' && lastResults.length === 0 && !lastImportSummary"
                    class="welcome-empty-state"
                    data-testid="welcome-empty-state"
                  >
                    <p>
                      Pick a dataset or import your own <code>.sql</code>. Nothing is stored on the
                      server; workspaces are deleted after 2 h idle. Your editor tabs and query
                      history stay in your browser's local storage.
                    </p>
                    <div class="welcome-actions">
                      <button
                        type="button"
                        class="tb-btn"
                        data-testid="welcome-empty-btn"
                        :disabled="running"
                        @click="handleWelcomePickEmpty"
                      >
                        Empty DB
                      </button>
                      <button
                        type="button"
                        class="tb-btn primary"
                        data-testid="welcome-sample-btn"
                        :disabled="running"
                        @click="handleWelcomePickSample"
                      >
                        Sample: Library
                      </button>
                      <button
                        type="button"
                        class="tb-btn"
                        data-testid="welcome-import-btn"
                        :disabled="running || importing"
                        @click="triggerImportPicker"
                      >
                        Import .sql…
                      </button>
                    </div>
                  </div>
                  <ResultGrid
                    v-else-if="resultTab === 'grid'"
                    :columns="activeResult?.columns ?? []"
                    :rows="activeResult?.rows ?? []"
                    :truncated="activeResult?.truncated"
                  />
                  <MessagesPanel
                    v-else
                    :results="lastResults"
                    :import-summary="lastImportSummary"
                  />
                </div>
              </div>
            </Pane>

            <!-- Bottom: Status log -->
            <Pane :size="18" :min-size="10">
              <StatusLog :entries="statusEntries" @clear="statusEntries = []" />
            </Pane>
          </Splitpanes>
        </Pane>
      </Splitpanes>
    </main>

    <!-- Bottom File Tabs -->
    <TabBar
      :tabs="tabs"
      :active-tab-id="activeTabId"
      @select="(id) => (activeTabId = id)"
      @add="handleAddTab"
      @close="handleCloseTab"
      @rename="handleRenameTab"
    />

    <!-- Session Settings Drawer -->
    <SettingsDrawer
      :open="settingsOpen"
      :settings="settings"
      :disabled="running"
      @close="settingsOpen = false"
      @update:stop-on-error="(v) => (settings.stopOnError = v)"
      @toggle-safe-updates="handleToggleSafeUpdates"
      @toggle-only-full-group-by="handleToggleOnlyFullGroupBy"
      @toggle-strict="handleToggleStrict"
      @change-isolation="handleChangeIsolation"
      @toggle-autocommit="handleToggleAutocommit"
      @change-theme="(t) => (settings.theme = t)"
    />

    <!-- About Modal -->
    <AboutModal :open="aboutOpen" @close="aboutOpen = false" />

    <!-- Import SQL Modal + Hidden File Input -->
    <input
      ref="importFileInputRef"
      type="file"
      accept=".sql,.txt,application/sql,text/plain"
      class="sr-only"
      data-testid="import-file-input"
      @change="handleImportInputChange"
    />
    <ImportModal
      :open="importModalOpen"
      :file-name="pendingImportFile?.name ?? ''"
      :file-size-bytes="pendingImportFile?.size ?? 0"
      :importing="importing"
      :error-message="importModalError"
      @close="handleCloseImportModal"
      @confirm="handleConfirmImport"
    />
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar-right {
  margin-left: auto;
}

.brand {
  font-weight: 700;
  font-size: 14px;
  letter-spacing: -0.01em;
  margin-right: 4px;
}

.tb-select {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  font-size: 12.5px;
}

.tb-btn {
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  cursor: pointer;
  font-size: 12.5px;
  white-space: nowrap;
}

.tb-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.tb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tb-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
  font-weight: 600;
}

.tb-btn.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.tb-btn.danger:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
}

.tx-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--warning-bg);
  color: var(--warning);
  font-size: 12px;
  font-weight: 600;
}

.maintenance-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--error-bg, #fee2e2);
  color: var(--error, #991b1b);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
}

.notice-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--warning-bg);
  color: var(--warning);
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}

.banner-close {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}

.workspace-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.sidebar-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.sidebar-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.exercises-placeholder {
  padding: 14px;
  color: var(--text-secondary);
}

.sidebar-switcher {
  display: flex;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-header);
}

.pane-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.pane-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  height: 30px;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.result-header-bar {
  justify-content: space-between;
}

.tab-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.sub-tab {
  padding: 4px 10px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
}

.sub-tab:hover {
  color: var(--text-primary);
}

.sub-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.pane-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.welcome-empty-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 20px 24px;
  gap: 14px;
  color: var(--text-secondary);
}

.welcome-empty-state p {
  max-width: 540px;
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.welcome-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
