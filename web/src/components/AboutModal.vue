<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ABOUT_INFO } from '../about';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const dialogRef = ref<HTMLElement | null>(null);
const closeBtnRef = ref<HTMLButtonElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

function getFocusableElements(): HTMLElement[] {
  const container = dialogRef.value;
  if (!container) return [];
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');
  return Array.from(container.querySelectorAll<HTMLElement>(selector));
}

function handleKeydown(event: KeyboardEvent): void {
  if (!props.open) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }

  if (event.key === 'Tab') {
    const focusable = getFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      if (!active || active === first || !dialogRef.value?.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (!active || active === last || !dialogRef.value?.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (typeof document === 'undefined') return;
    if (isOpen) {
      previouslyFocused = document.activeElement as HTMLElement | null;
      document.addEventListener('keydown', handleKeydown);
      await nextTick();
      closeBtnRef.value?.focus();
    } else {
      document.removeEventListener('keydown', handleKeydown);
      previouslyFocused?.focus();
      previouslyFocused = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('keydown', handleKeydown);
  }
});
</script>

<template>
  <div
    v-if="open"
    class="about-backdrop"
    data-testid="about-backdrop"
    @click.self="emit('close')"
  >
    <div
      ref="dialogRef"
      class="about-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-modal-title"
      data-testid="about-modal"
    >
      <div class="about-header">
        <h2 id="about-modal-title">About SQL Scratchpad</h2>
        <button
          ref="closeBtnRef"
          type="button"
          class="about-close-btn"
          aria-label="Close About dialog"
          data-testid="about-close-btn"
          @click="emit('close')"
        >
          ×
        </button>
      </div>

      <div class="about-body">
        <p class="about-tagline">{{ ABOUT_INFO.tagline }}</p>
        <p class="about-version" data-testid="about-version">
          Version {{ ABOUT_INFO.version }} · build {{ ABOUT_INFO.gitSha }}
        </p>

        <dl class="about-meta">
          <div class="about-row">
            <dt>Developer</dt>
            <dd>
              {{ ABOUT_INFO.developerName }} ·
              <a
                :href="`mailto:${ABOUT_INFO.developerEmail}`"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="about-email-link"
              >
                {{ ABOUT_INFO.developerEmail }}
              </a>
            </dd>
          </div>
          <div class="about-row">
            <dt>Source</dt>
            <dd>
              <a
                :href="ABOUT_INFO.sourceUrl"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="about-source-link"
              >
                {{ ABOUT_INFO.sourceUrl }}
              </a>
            </dd>
          </div>
          <div class="about-row">
            <dt>Sister project</dt>
            <dd>
              <a
                :href="ABOUT_INFO.sisterProjectUrl"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="about-sister-link"
              >
                {{ ABOUT_INFO.sisterProjectName }}
              </a>
            </dd>
          </div>
          <div class="about-row">
            <dt>Built with</dt>
            <dd>{{ ABOUT_INFO.builtWith }}</dd>
          </div>
          <div class="about-row">
            <dt>Privacy</dt>
            <dd data-testid="about-privacy">{{ ABOUT_INFO.privacy }}</dd>
          </div>
        </dl>

        <p class="about-disclaimer">{{ ABOUT_INFO.disclaimer }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.about-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.about-card {
  width: 480px;
  max-width: 96vw;
  background: var(--bg-panel);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
}

.about-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  border-radius: 6px 6px 0 0;
}

.about-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.about-close-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-primary);
  border-radius: 3px;
  width: 26px;
  height: 26px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}

.about-close-btn:hover {
  background: var(--bg-hover);
}

.about-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
  line-height: 1.45;
}

.about-tagline {
  margin: 0;
  font-weight: 600;
}

.about-version {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
}

.about-meta {
  margin: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  padding: 10px 0;
}

.about-row {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 8px;
}

.about-row dt {
  font-weight: 600;
  color: var(--text-secondary);
}

.about-row dd {
  margin: 0;
  word-break: break-word;
}

.about-row a {
  color: var(--accent);
  text-decoration: none;
}

.about-row a:hover {
  text-decoration: underline;
}

.about-disclaimer {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
