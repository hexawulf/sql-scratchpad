<script setup lang="ts">
import type { HistoryEntry } from '../types/state';

defineProps<{
  entries: HistoryEntry[];
}>();

const emit = defineEmits<{
  load: [entry: HistoryEntry];
  clear: [];
}>();
</script>

<template>
  <div class="history-panel" data-testid="history-panel">
    <div class="history-bar">
      <span class="history-count">{{ entries.length }} execution(s)</span>
      <button type="button" class="mini-btn" :disabled="entries.length === 0" @click="emit('clear')">
        Clear history
      </button>
    </div>
    <div class="history-list">
      <div v-if="entries.length === 0" class="history-empty">
        Executed queries will appear here.
      </div>
      <button
        v-for="(entry, idx) in entries"
        :key="`${entry.ts}-${idx}`"
        type="button"
        class="history-item"
        @click="emit('load', entry)"
      >
        <div class="history-meta">
          <span class="history-ts">{{ new Date(entry.ts).toLocaleTimeString() }}</span>
          <span class="history-tag">{{ entry.dataset }}</span>
          <span class="history-summary">{{ entry.summary }}</span>
        </div>
        <pre class="history-sql">{{ entry.sql }}</pre>
      </button>
    </div>
  </div>
</template>

<style scoped>
.history-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.history-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 10px;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
}

.history-count {
  color: var(--text-secondary);
}

.mini-btn {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  cursor: pointer;
  font-size: 11.5px;
}

.mini-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.history-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-empty {
  color: var(--text-muted);
  padding: 12px;
}

.history-item {
  width: 100%;
  text-align: left;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--bg-subtle);
  cursor: pointer;
}

.history-item:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}

.history-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.history-tag {
  background: var(--bg-active);
  color: var(--accent);
  padding: 0 5px;
  border-radius: 3px;
  font-weight: 600;
}

.history-sql {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  max-height: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre-wrap;
}
</style>
