<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ImportMode } from '@sqlyard/shared';

const MAX_IMPORT_BYTES = 6 * 1024 * 1024;

const props = defineProps<{
  open: boolean;
  fileName: string;
  fileSizeBytes: number;
  importing: boolean;
  errorMessage: string | null;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [mode: ImportMode];
}>();

const mode = ref<ImportMode>('fresh');

const tooLarge = computed(() => props.fileSizeBytes > MAX_IMPORT_BYTES);

const formattedSize = computed(() => {
  const bytes = props.fileSizeBytes;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
});

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !props.importing) {
    event.preventDefault();
    emit('close');
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      mode.value = 'fresh';
      document.addEventListener('keydown', handleKeydown);
    } else {
      document.removeEventListener('keydown', handleKeydown);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div
    v-if="open"
    class="modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="import-modal-title"
    data-testid="import-modal"
    @click.self="!importing && emit('close')"
  >
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="import-modal-title">Import SQL File</h2>
        <button
          type="button"
          class="close-btn"
          aria-label="Close import dialog"
          :disabled="importing"
          @click="emit('close')"
        >
          ×
        </button>
      </div>

      <div class="modal-body">
        <div class="file-meta">
          <span class="file-name">{{ fileName }}</span>
          <span class="file-size">{{ formattedSize }}</span>
        </div>

        <p v-if="tooLarge" class="import-err" role="alert">
          File exceeds the 6 MB import limit. Split it into smaller scripts or remove unnecessary
          data.
        </p>

        <fieldset class="mode-fieldset" :disabled="importing || tooLarge">
          <legend>Import target</legend>
          <label class="mode-option">
            <input
              v-model="mode"
              type="radio"
              name="import-mode"
              value="fresh"
              data-testid="import-mode-fresh"
            />
            <span>
              <strong>Fresh workspace</strong> (recommended)
              <small>Reset the workspace to an empty database first, then run the script.</small>
            </span>
          </label>
          <label class="mode-option">
            <input
              v-model="mode"
              type="radio"
              name="import-mode"
              value="append"
              data-testid="import-mode-append"
            />
            <span>
              <strong>Add to current</strong>
              <small>Execute statements on top of the tables already in this workspace.</small>
            </span>
          </label>
        </fieldset>

        <div v-if="importing" class="progress-box" role="status" data-testid="import-progress">
          <span class="spinner" aria-hidden="true" />
          <span>Importing {{ fileName }}… Large scripts may take several seconds.</span>
        </div>

        <p v-if="errorMessage" class="import-err" role="alert">{{ errorMessage }}</p>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn" :disabled="importing" @click="emit('close')">
          Cancel
        </button>
        <button
          type="button"
          class="btn primary"
          data-testid="import-confirm-btn"
          :disabled="importing || tooLarge"
          @click="emit('confirm', mode)"
        >
          {{ importing ? 'Importing…' : 'Import' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.modal-card {
  width: 460px;
  max-width: 96vw;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.modal-header h2 {
  margin: 0;
  font-size: 15px;
}

.close-btn {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  width: 26px;
  height: 26px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}

.modal-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.file-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  font-size: 12.5px;
}

.file-name {
  font-family: var(--font-mono);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  color: var(--text-muted);
  margin-left: 10px;
  flex-shrink: 0;
}

.mode-fieldset {
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mode-fieldset legend {
  padding: 0 4px;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.mode-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}

.mode-option span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mode-option small {
  color: var(--text-muted);
  font-size: 11.5px;
}

.progress-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-active);
  color: var(--accent);
  font-size: 12.5px;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--accent);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.import-err {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 12.5px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.btn {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
  cursor: pointer;
  font-size: 12.5px;
}

.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
  font-weight: 600;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
