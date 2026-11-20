<script setup lang="ts">
import type { ImportResponse, StatementResult } from '@sql-scratchpad/shared';
import { formatDurationSeconds } from '../utils/status-format';

export interface ImportSummaryRecord {
  fileName: string;
  response: ImportResponse;
  sqlText?: string;
}

defineProps<{
  results: StatementResult[];
  importSummary?: ImportSummaryRecord | null;
}>();

const emit = defineEmits<{
  'open-in-editor': [fileName: string, sqlText: string];
}>();
</script>

<template>
  <div class="messages-panel" data-testid="messages-panel">
    <div
      v-if="importSummary"
      class="msg-card import-card"
      :class="importSummary.response.ok ? 'kind-ok' : 'kind-error'"
      data-testid="import-summary-card"
    >
      <div class="msg-head">
        <strong>
          Import: {{ importSummary.fileName }} ({{
            importSummary.response.mode === 'fresh' ? 'fresh workspace' : 'added to current'
          }})
        </strong>
        <span class="msg-dur"
          >{{ formatDurationSeconds(importSummary.response.durationMs) }} s</span
        >
      </div>

      <div class="import-stats">
        <span
          >Status:
          <strong>{{ importSummary.response.ok ? 'OK' : 'Stopped on error' }}</strong></span
        >
        <span>Run: {{ importSummary.response.statementsRun }}</span>
        <span>OK: {{ importSummary.response.statementsOk }}</span>
        <span>Skipped: {{ importSummary.response.skippedCount }}</span>
        <span>Rewritten: {{ importSummary.response.rewrittenCount }}</span>
        <span>Warnings: {{ importSummary.response.warningsCount }}</span>
      </div>

      <div v-if="importSummary.response.tablesCreated.length > 0" class="import-tables">
        Tables created ({{ importSummary.response.tablesCreated.length }}):
        <code>{{ importSummary.response.tablesCreated.join(', ') }}</code>
      </div>

      <div v-if="importSummary.response.error" class="msg-error">
        Statement #{{ importSummary.response.error.index + 1 }} (line
        {{ importSummary.response.error.startLine }}): ERROR{{
          importSummary.response.error.errno !== undefined
            ? ` ${importSummary.response.error.errno}`
            : ''
        }}{{
          importSummary.response.error.sqlState
            ? ` (${importSummary.response.error.sqlState})`
            : ''
        }}: {{ importSummary.response.error.message }}
      </div>
      <div
        v-if="importSummary.response.error?.hint"
        class="import-hint"
        data-testid="import-error-hint"
      >
        {{ importSummary.response.error.hint }}
      </div>
      <div v-if="importSummary.response.note" class="import-note">
        {{ importSummary.response.note }}
      </div>
      <div
        v-if="!importSummary.response.ok && importSummary.sqlText !== undefined"
        class="import-error-actions"
      >
        <button
          type="button"
          class="mini-action-btn"
          data-testid="import-error-open-editor-btn"
          @click="emit('open-in-editor', importSummary.fileName, importSummary.sqlText)"
        >
          Open in editor
        </button>
      </div>

      <details v-if="importSummary.response.rewritten.length > 0" class="skipped-details">
        <summary>
          Rewritten statements ({{ importSummary.response.rewrittenCount
          }}<span v-if="importSummary.response.rewrittenTruncated"> — showing first 100</span>)
        </summary>
        <ul class="skipped-list">
          <li v-for="r in importSummary.response.rewritten" :key="`rw-${r.index}-${r.startLine}`">
            Line {{ r.startLine }}: {{ r.reason }} — <code>{{ r.snippet }}</code>
          </li>
        </ul>
      </details>

      <details v-if="importSummary.response.skipped.length > 0" class="skipped-details">
        <summary>
          Skipped statements ({{ importSummary.response.skippedCount
          }}<span v-if="importSummary.response.skippedTruncated"> — showing first 100</span>)
        </summary>
        <ul class="skipped-list">
          <li v-for="s in importSummary.response.skipped" :key="`${s.index}-${s.startLine}`">
            Line {{ s.startLine }}: {{ s.reason }} — <code>{{ s.snippet }}</code>
          </li>
        </ul>
      </details>
    </div>

    <div v-if="results.length === 0 && !importSummary" class="messages-empty">
      No statements executed yet.
    </div>
    <div v-for="res in results" :key="res.index" class="msg-card" :class="`kind-${res.kind}`">
      <div class="msg-head">
        <span class="msg-idx">#{{ res.index + 1 }} (line {{ res.startLine }})</span>
        <span class="msg-dur">{{ formatDurationSeconds(res.durationMs) }} s</span>
      </div>
      <pre class="msg-sql">{{ res.sql }}</pre>
      <div v-if="res.kind === 'rows'" class="msg-detail">
        Returned {{ res.rowCount ?? res.rows?.length ?? 0 }} row(s)
        <span v-if="res.truncated"> (truncated)</span>.
      </div>
      <div v-else-if="res.kind === 'ok'" class="msg-detail">
        OK. Rows affected: {{ res.affectedRows ?? 0 }}
        <span v-if="res.insertId !== undefined && res.insertId !== 0">
          · Insert ID: {{ res.insertId }}
        </span>
      </div>
      <div v-else class="msg-error">
        ERROR{{ res.error?.errno !== undefined ? ` ${res.error.errno}` : ''
        }}{{ res.error?.sqlState ? ` (${res.error.sqlState})` : '' }}:
        {{ res.error?.message }}
      </div>
      <ul v-if="res.warnings && res.warnings.length > 0" class="msg-warnings">
        <li v-for="(w, i) in res.warnings" :key="i">{{ w.level }} {{ w.code }}: {{ w.message }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.messages-panel {
  height: 100%;
  overflow: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.messages-empty {
  color: var(--text-muted);
  padding: 8px;
}

.msg-card {
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--bg-subtle);
}

.msg-card.kind-error {
  border-color: var(--danger);
  background: var(--danger-bg);
}

.msg-head {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.import-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  margin-bottom: 6px;
}

.import-tables {
  font-size: 12px;
  margin-bottom: 6px;
}

.import-note {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.import-hint {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--warning-bg);
  color: var(--warning);
  font-size: 12px;
  line-height: 1.4;
}

.import-error-actions {
  margin-top: 8px;
}

.mini-action-btn {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.mini-action-btn:hover {
  background: var(--bg-hover);
}

.skipped-details {
  margin-top: 6px;
  font-size: 12px;
}

.skipped-details summary {
  cursor: pointer;
  color: var(--text-secondary);
}

.skipped-list {
  margin: 4px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11.5px;
}

.msg-sql {
  margin: 0 0 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg-detail {
  font-size: 12px;
  color: var(--success);
}

.msg-error {
  font-size: 12px;
  color: var(--danger);
  font-weight: 600;
}

.msg-warnings {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--warning);
  font-size: 12px;
}
</style>
