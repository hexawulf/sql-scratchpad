<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { SchemaTable, SchemaTree } from '@sqlyard/shared';

const props = defineProps<{
  schema: SchemaTree | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
  'insert-ident': [ident: string];
  'preview-table': [tableName: string];
  'drop-sql-file': [file: File];
}>();

const dragDepth = ref(0);
const dragOver = ref(false);

function handleDragEnter(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return;
  dragDepth.value += 1;
  dragOver.value = true;
}

function handleDragOver(event: DragEvent): void {
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
}

function handleDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
  if (dragDepth.value === 0) {
    dragOver.value = false;
  }
}

function handleDrop(event: DragEvent): void {
  dragDepth.value = 0;
  dragOver.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    emit('drop-sql-file', file);
  }
}

const expanded = reactive<Record<string, boolean>>({
  root: true,
  tables: true,
  views: true,
});

watch(
  () => props.schema,
  (next) => {
    if (!next) return;
    // Expand the first table by default so columns are immediately visible
    const first = next.tables[0];
    if (first && expanded[`table:${first.name}`] === undefined) {
      expanded[`table:${first.name}`] = true;
      expanded[`cols:${first.name}`] = true;
    }
  },
  { immediate: true },
);

function toggle(key: string): void {
  expanded[key] = !expanded[key];
}

function isForeignKeyColumn(table: SchemaTable, columnName: string): boolean {
  return table.foreignKeys.some((fk) => fk.columns.includes(columnName));
}

function engineLabel(engine: SchemaTree['engine']): string {
  return engine === 'mariadb' ? 'MariaDB 11.4' : 'SQLite 3';
}
</script>

<template>
  <div
    class="schema-panel"
    :class="{ 'drag-active': dragOver }"
    data-testid="schema-tree"
    @dragenter.prevent="handleDragEnter"
    @dragover.prevent="handleDragOver"
    @dragleave="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <div v-if="dragOver" class="drop-overlay" data-testid="tree-drop-overlay">
      Drop .sql file to import
    </div>
    <div class="panel-header">
      <span class="panel-title">Databases</span>
      <button
        type="button"
        class="icon-btn"
        title="Refresh schema"
        :disabled="loading"
        @click="emit('refresh')"
      >
        ↻
      </button>
    </div>

    <div class="tree-scroll">
      <div v-if="!schema && loading" class="tree-empty">Loading schema…</div>
      <div v-else-if="!schema" class="tree-empty">No workspace connected.</div>

      <ul v-else class="tree-root" role="tree">
        <li role="treeitem" :aria-expanded="!!expanded.root">
          <button type="button" class="tree-row tree-db" @click="toggle('root')">
            <span class="caret">{{ expanded.root ? '▾' : '▸' }}</span>
            <span class="db-name">{{ schema.database }}</span>
            <span class="db-engine">({{ engineLabel(schema.engine) }})</span>
          </button>

          <ul v-if="expanded.root" class="tree-branch" role="group">
            <!-- Tables -->
            <li role="treeitem" :aria-expanded="!!expanded.tables">
              <button type="button" class="tree-row" @click="toggle('tables')">
                <span class="caret">{{ expanded.tables ? '▾' : '▸' }}</span>
                <span>Tables ({{ schema.tables.length }})</span>
              </button>

              <ul v-if="expanded.tables" class="tree-branch" role="group">
                <li v-if="schema.tables.length === 0" class="tree-leaf muted">(none)</li>
                <li
                  v-for="table in schema.tables"
                  :key="table.name"
                  role="treeitem"
                  :aria-expanded="!!expanded[`table:${table.name}`]"
                >
                  <button
                    type="button"
                    class="tree-row"
                    :title="`Double-click to SELECT * FROM ${table.name}`"
                    @click="toggle(`table:${table.name}`)"
                    @dblclick="emit('preview-table', table.name)"
                  >
                    <span class="caret">{{ expanded[`table:${table.name}`] ? '▾' : '▸' }}</span>
                    <span class="node-table">{{ table.name }}</span>
                  </button>

                  <ul v-if="expanded[`table:${table.name}`]" class="tree-branch" role="group">
                    <!-- Columns -->
                    <li>
                      <button
                        type="button"
                        class="tree-row"
                        @click="toggle(`cols:${table.name}`)"
                      >
                        <span class="caret">{{ expanded[`cols:${table.name}`] !== false ? '▾' : '▸' }}</span>
                        <span>Columns ({{ table.columns.length }})</span>
                      </button>
                      <ul v-if="expanded[`cols:${table.name}`] !== false" class="tree-branch">
                        <li
                          v-for="col in table.columns"
                          :key="col.name"
                          class="tree-leaf col-leaf"
                          @click="emit('insert-ident', col.name)"
                        >
                          <span class="col-name">{{ col.name }}</span>
                          <span class="col-type"> : {{ col.type }}</span>
                          <span v-if="col.key === 'PRI'" class="key-badge pk" title="Primary Key">
                            🔑 PK
                          </span>
                          <span
                            v-if="isForeignKeyColumn(table, col.name)"
                            class="key-badge fk"
                            title="Foreign Key"
                          >
                            🔗 FK
                          </span>
                          <span v-if="col.key === 'UNI'" class="key-badge uni" title="Unique">
                            UNI
                          </span>
                        </li>
                      </ul>
                    </li>

                    <!-- Indexes -->
                    <li>
                      <button
                        type="button"
                        class="tree-row"
                        @click="toggle(`idx:${table.name}`)"
                      >
                        <span class="caret">{{ expanded[`idx:${table.name}`] ? '▾' : '▸' }}</span>
                        <span>Indexes ({{ table.indexes.length }})</span>
                      </button>
                      <ul v-if="expanded[`idx:${table.name}`]" class="tree-branch">
                        <li v-if="table.indexes.length === 0" class="tree-leaf muted">(none)</li>
                        <li v-for="idx in table.indexes" :key="idx.name" class="tree-leaf">
                          <span>{{ idx.name }}</span>
                          <span class="col-type"> ({{ idx.columns.join(', ') }})</span>
                        </li>
                      </ul>
                    </li>

                    <!-- Triggers -->
                    <li>
                      <button
                        type="button"
                        class="tree-row"
                        @click="toggle(`trg:${table.name}`)"
                      >
                        <span class="caret">{{ expanded[`trg:${table.name}`] ? '▾' : '▸' }}</span>
                        <span>Triggers ({{ table.triggers.length }})</span>
                      </button>
                      <ul v-if="expanded[`trg:${table.name}`]" class="tree-branch">
                        <li v-if="table.triggers.length === 0" class="tree-leaf muted">(none)</li>
                        <li v-for="trg in table.triggers" :key="trg" class="tree-leaf">
                          {{ trg }}
                        </li>
                      </ul>
                    </li>
                  </ul>
                </li>
              </ul>
            </li>

            <!-- Views -->
            <li role="treeitem" :aria-expanded="!!expanded.views">
              <button type="button" class="tree-row" @click="toggle('views')">
                <span class="caret">{{ expanded.views ? '▾' : '▸' }}</span>
                <span>Views ({{ schema.views.length }})</span>
              </button>
              <ul v-if="expanded.views" class="tree-branch" role="group">
                <li v-if="schema.views.length === 0" class="tree-leaf muted">(none)</li>
                <li
                  v-for="view in schema.views"
                  :key="view.name"
                  class="tree-leaf col-leaf"
                  @dblclick="emit('preview-table', view.name)"
                >
                  {{ view.name }}
                </li>
              </ul>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.schema-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.schema-panel.drag-active {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}

.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-active);
  color: var(--accent);
  font-weight: 600;
  font-size: 13px;
  pointer-events: none;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-subtle);
  font-weight: 600;
  font-size: 12px;
}

.icon-btn {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  padding: 1px 6px;
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.tree-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 4px;
  font-size: 12px;
}

.tree-empty {
  padding: 10px;
  color: var(--text-muted);
}

.tree-root,
.tree-branch {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tree-branch {
  padding-left: 14px;
}

.tree-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.tree-row:hover {
  background: var(--bg-hover);
}

.tree-db {
  font-weight: 600;
}

.db-engine {
  color: var(--text-muted);
  font-weight: 400;
}

.caret {
  width: 12px;
  display: inline-block;
  color: var(--text-muted);
}

.node-table {
  font-weight: 600;
}

.tree-leaf {
  padding: 2px 6px 2px 18px;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.col-leaf {
  cursor: pointer;
  border-radius: 4px;
}

.col-leaf:hover {
  background: var(--bg-hover);
}

.col-type {
  color: var(--text-muted);
}

.muted {
  color: var(--text-muted);
  font-style: italic;
}

.key-badge {
  margin-left: 4px;
  font-size: 10px;
  font-family: var(--font-sans);
  padding: 0 4px;
  border-radius: 3px;
  font-weight: 600;
}

.key-badge.pk {
  background: var(--warning-bg);
  color: var(--warning);
}

.key-badge.fk {
  background: var(--bg-active);
  color: var(--accent);
}

.key-badge.uni {
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
</style>
