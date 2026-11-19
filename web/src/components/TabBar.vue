<script setup lang="ts">
import { ref } from 'vue';
import type { EditorTab } from '../types/state';

defineProps<{
  tabs: EditorTab[];
  activeTabId: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  add: [];
  close: [id: string];
  rename: [id: string, title: string];
}>();

const editingId = ref<string | null>(null);
const draftTitle = ref('');

function startRename(tab: EditorTab): void {
  editingId.value = tab.id;
  draftTitle.value = tab.title;
}

function commitRename(id: string): void {
  const trimmed = draftTitle.value.trim();
  if (trimmed) {
    emit('rename', id, trimmed);
  }
  editingId.value = null;
}
</script>

<template>
  <footer class="tab-bar" role="tablist" aria-label="SQL files" data-testid="tab-bar">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="file-tab"
      :class="{ active: tab.id === activeTabId }"
      role="tab"
      :aria-selected="tab.id === activeTabId"
      @click="emit('select', tab.id)"
      @dblclick="startRename(tab)"
    >
      <input
        v-if="editingId === tab.id"
        v-model="draftTitle"
        class="tab-rename-input"
        @click.stop
        @keydown.enter.prevent="commitRename(tab.id)"
        @keydown.escape.prevent="editingId = null"
        @blur="commitRename(tab.id)"
      />
      <span v-else class="tab-title">{{ tab.title }}</span>
      <button
        v-if="tabs.length > 1"
        type="button"
        class="tab-close"
        :aria-label="`Close ${tab.title}`"
        @click.stop="emit('close', tab.id)"
      >
        ×
      </button>
    </div>
    <button
      type="button"
      class="tab-add"
      title="New SQL tab"
      aria-label="New SQL tab"
      data-testid="add-tab-btn"
      @click="emit('add')"
    >
      +
    </button>
  </footer>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  height: 30px;
  background: var(--bg-header);
  border-top: 1px solid var(--border);
  overflow-x: auto;
  flex-shrink: 0;
}

.file-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.file-tab:hover {
  background: var(--bg-hover);
}

.file-tab.active {
  background: var(--bg-surface);
  border-color: var(--border);
  color: var(--text-primary);
  font-weight: 600;
}

.tab-rename-input {
  width: 140px;
  padding: 0 4px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--bg-surface);
  font-size: 12px;
}

.tab-close {
  border: none;
  background: transparent;
  padding: 0 2px;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1;
}

.tab-close:hover {
  color: var(--danger);
}

.tab-add {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  width: 24px;
  height: 22px;
  cursor: pointer;
  font-weight: 600;
  margin-left: 4px;
}

.tab-add:hover {
  background: var(--bg-hover);
}
</style>
