<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { StatusLogEntry } from '../types/state';

const props = defineProps<{
  entries: StatusLogEntry[];
}>();

const emit = defineEmits<{
  clear: [];
}>();

const listEl = ref<HTMLDivElement | null>(null);

watch(
  () => props.entries.length,
  async () => {
    await nextTick();
    if (listEl.value) {
      listEl.value.scrollTop = listEl.value.scrollHeight;
    }
  },
);
</script>

<template>
  <div class="status-panel" data-testid="status-log">
    <div class="status-header">
      <span class="status-title">Status</span>
      <button
        type="button"
        class="mini-btn"
        :disabled="entries.length === 0"
        @click="emit('clear')"
      >
        Clear
      </button>
    </div>
    <div ref="listEl" class="status-body" role="log" aria-live="polite">
      <div v-if="entries.length === 0" class="status-empty">Ready.</div>
      <div
        v-for="entry in entries"
        :key="entry.id"
        class="status-line"
        :class="`level-${entry.level}`"
      >
        {{ entry.message }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.status-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.status-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-subtle);
  font-weight: 600;
  font-size: 12px;
}

.mini-btn {
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  cursor: pointer;
  font-size: 11.5px;
}

.mini-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.mini-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.status-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.status-empty {
  color: var(--text-muted);
}

.status-line {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 1px 0;
}

.level-error {
  color: var(--danger);
}

.level-warning {
  color: var(--warning);
}

.level-notice {
  color: var(--accent);
}
</style>
