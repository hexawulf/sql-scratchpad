<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import type { ColumnMeta } from '@sql-scratchpad/shared';
import {
  formatCellText,
  isNumericColumnType,
  isNumericValue,
  toMarkdownTable,
  toTsv,
} from '../utils/export-grid';

const props = defineProps<{
  columns: ColumnMeta[];
  rows: unknown[][];
  truncated?: boolean;
}>();

const ROW_HEIGHT = 28;

const scrollEl = ref<HTMLDivElement | null>(null);
const sortCol = ref<number | null>(null);
const sortDir = ref<'asc' | 'desc'>('asc');
const copyFeedback = ref<string>('');

watch(
  () => [props.columns, props.rows],
  () => {
    sortCol.value = null;
    sortDir.value = 'asc';
  },
);

const numericFlags = computed(() => props.columns.map((c) => isNumericColumnType(c.type)));

const sortedRows = computed<unknown[][]>(() => {
  if (sortCol.value === null) return props.rows;
  const idx = sortCol.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const colNumeric = numericFlags.value[idx] ?? false;

  return [...props.rows].sort((a, b) => {
    const av = a[idx];
    const bv = b[idx];
    if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
    if (bv === null || bv === undefined) return -1;
    if (colNumeric || (isNumericValue(av) && isNumericValue(bv))) {
      const an = Number(av);
      const bn = Number(bv);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) {
        return (an - bn) * dir;
      }
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
});

const rowVirtualizer = useVirtualizer(
  computed(() => ({
    count: sortedRows.value.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })),
);

const virtualItems = computed(() => rowVirtualizer.value.getVirtualItems());
const totalSize = computed(() => rowVirtualizer.value.getTotalSize());

const gridTemplateColumns = computed(() => {
  const cols = props.columns.map(() => 'minmax(110px, 1fr)');
  return `48px ${cols.join(' ')}`;
});

function toggleSort(colIdx: number): void {
  if (sortCol.value === colIdx) {
    if (sortDir.value === 'asc') {
      sortDir.value = 'desc';
    } else {
      sortCol.value = null;
      sortDir.value = 'asc';
    }
  } else {
    sortCol.value = colIdx;
    sortDir.value = 'asc';
  }
}

async function copyAs(format: 'tsv' | 'md'): Promise<void> {
  const text =
    format === 'tsv'
      ? toTsv(props.columns, sortedRows.value)
      : toMarkdownTable(props.columns, sortedRows.value);
  try {
    await navigator.clipboard.writeText(text);
    copyFeedback.value = format === 'tsv' ? 'Copied TSV' : 'Copied Markdown';
    window.setTimeout(() => {
      copyFeedback.value = '';
    }, 1800);
  } catch {
    copyFeedback.value = 'Clipboard blocked';
    window.setTimeout(() => {
      copyFeedback.value = '';
    }, 1800);
  }
}

function isCellNumeric(colIdx: number, val: unknown): boolean {
  if (val === null || val === undefined) return false;
  return (numericFlags.value[colIdx] ?? false) || isNumericValue(val);
}
</script>

<template>
  <div class="grid-wrapper">
    <div class="grid-toolbar">
      <div class="grid-counts" data-testid="row-count-summary">
        <span>Total rows loaded: {{ rows.length }}</span>
        <span v-if="truncated" class="truncated-badge" data-testid="truncated-notice">
          (truncated at {{ rows.length }})
        </span>
      </div>
      <div class="grid-actions">
        <span v-if="copyFeedback" class="copy-feedback">{{ copyFeedback }}</span>
        <button
          type="button"
          class="mini-btn"
          :disabled="columns.length === 0"
          @click="copyAs('tsv')"
        >
          Copy TSV
        </button>
        <button
          type="button"
          class="mini-btn"
          :disabled="columns.length === 0"
          @click="copyAs('md')"
        >
          Copy Markdown
        </button>
      </div>
    </div>

    <div v-if="columns.length === 0" class="grid-empty">Run a query to view results.</div>

    <div
      v-else
      ref="scrollEl"
      class="grid-scroll"
      role="grid"
      :aria-rowcount="sortedRows.length + 1"
      :aria-colcount="columns.length + 1"
      data-testid="result-grid"
    >
      <div class="grid-inner">
        <div
          class="grid-row grid-header"
          role="row"
          aria-rowindex="1"
          :style="{ gridTemplateColumns }"
        >
          <div class="grid-cell row-num-cell" role="columnheader">#</div>
          <button
            v-for="(col, idx) in columns"
            :key="`${idx}-${col.name}`"
            type="button"
            class="grid-cell header-btn"
            :class="{ 'is-numeric': numericFlags[idx] }"
            role="columnheader"
            :aria-sort="sortCol === idx ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
            :title="`${col.name} (${col.type})`"
            @click="toggleSort(idx)"
          >
            <span class="col-name">{{ col.name }}</span>
            <span v-if="sortCol === idx" class="sort-indicator">
              {{ sortDir === 'asc' ? '▲' : '▼' }}
            </span>
          </button>
        </div>

        <div class="grid-body" :style="{ height: `${totalSize}px` }">
          <div
            v-for="vRow in virtualItems"
            :key="String(vRow.key)"
            class="grid-row grid-data-row"
            :class="{ 'is-even': vRow.index % 2 === 1 }"
            role="row"
            :aria-rowindex="vRow.index + 2"
            :style="{
              gridTemplateColumns,
              height: `${ROW_HEIGHT}px`,
              transform: `translateY(${vRow.start}px)`,
            }"
          >
            <div class="grid-cell row-num-cell" role="gridcell">{{ vRow.index + 1 }}</div>
            <div
              v-for="(col, cIdx) in columns"
              :key="`${vRow.index}-${cIdx}-${col.name}`"
              class="grid-cell"
              :class="{
                'is-null':
                  sortedRows[vRow.index]?.[cIdx] === null ||
                  sortedRows[vRow.index]?.[cIdx] === undefined,
                'is-numeric': isCellNumeric(cIdx, sortedRows[vRow.index]?.[cIdx]),
              }"
              role="gridcell"
              :title="formatCellText(sortedRows[vRow.index]?.[cIdx])"
            >
              {{ formatCellText(sortedRows[vRow.index]?.[cIdx]) }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.grid-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 10px;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
}

.grid-counts {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
}

.truncated-badge {
  color: var(--warning);
  font-weight: 600;
}

.grid-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.copy-feedback {
  color: var(--success);
  font-size: 11px;
}

.mini-btn {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  cursor: pointer;
  font-size: 12px;
}

.mini-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.mini-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.grid-empty {
  padding: 18px;
  color: var(--text-muted);
}

.grid-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
}

.grid-inner {
  min-width: max-content;
  width: 100%;
}

.grid-row {
  display: grid;
  width: 100%;
  border-bottom: 1px solid var(--border-subtle);
}

.grid-header {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}

.grid-body {
  position: relative;
  width: 100%;
}

.grid-data-row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}

.grid-data-row.is-even {
  background: var(--bg-subtle);
}

.grid-cell {
  padding: 4px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-right: 1px solid var(--border-subtle);
  line-height: 20px;
}

.header-btn {
  border-top: none;
  border-bottom: none;
  border-left: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
}

.header-btn:hover {
  background: var(--bg-hover);
}

.header-btn.is-numeric {
  justify-content: flex-end;
}

.col-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.sort-indicator {
  font-size: 10px;
  color: var(--accent);
}

.row-num-cell {
  text-align: right;
  color: var(--text-muted);
  background: var(--bg-header);
  user-select: none;
}

.is-numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.is-null {
  color: var(--null-text);
  font-style: italic;
}
</style>
