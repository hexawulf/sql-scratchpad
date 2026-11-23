<script setup lang="ts">
import type { AppSettings, IsolationLevel } from '../types/state';

defineProps<{
  open: boolean;
  settings: AppSettings;
  disabled: boolean;
}>();

const emit = defineEmits<{
  close: [];
  'update:stopOnError': [value: boolean];
  'toggle-safe-updates': [value: boolean];
  'toggle-only-full-group-by': [value: boolean];
  'toggle-strict': [value: boolean];
  'change-isolation': [value: IsolationLevel];
  'toggle-autocommit': [value: boolean];
  'change-theme': [value: 'light' | 'dark'];
}>();

const ISOLATION_LEVELS: IsolationLevel[] = [
  'READ UNCOMMITTED',
  'READ COMMITTED',
  'REPEATABLE READ',
  'SERIALIZABLE',
];
</script>

<template>
  <aside
    v-if="open"
    class="drawer-backdrop"
    role="dialog"
    aria-label="Session settings"
    data-testid="settings-drawer"
    @click.self="emit('close')"
  >
    <div class="drawer-card">
      <div class="drawer-header">
        <h2>Session Settings</h2>
        <button type="button" class="close-btn" aria-label="Close settings" @click="emit('close')">
          ×
        </button>
      </div>

      <div class="drawer-body">
        <section class="setting-group">
          <h3>Execution</h3>
          <label class="setting-row">
            <input
              type="checkbox"
              :checked="settings.stopOnError"
              @change="emit('update:stopOnError', ($event.target as HTMLInputElement).checked)"
            />
            <span>
              <strong>Stop on error</strong>
              <small>Halt multi-statement scripts at the first error.</small>
            </span>
          </label>
        </section>

        <section class="setting-group">
          <h3>MariaDB Session Toggles</h3>
          <p class="group-note">
            Each change runs a <code>SET SESSION</code> statement on the active connection and logs
            it in the Status pane.
          </p>

          <label class="setting-row">
            <input
              type="checkbox"
              :checked="settings.safeUpdates"
              :disabled="disabled"
              @change="emit('toggle-safe-updates', ($event.target as HTMLInputElement).checked)"
            />
            <span>
              <strong>Safe Update Mode</strong>
              <small
                ><code>sql_safe_updates = 1</code> — block UPDATE/DELETE without a key in
                WHERE</small
              >
            </span>
          </label>

          <label class="setting-row">
            <input
              type="checkbox"
              :checked="settings.onlyFullGroupBy"
              :disabled="disabled"
              @change="
                emit('toggle-only-full-group-by', ($event.target as HTMLInputElement).checked)
              "
            />
            <span>
              <strong>ONLY_FULL_GROUP_BY</strong>
              <small>Require non-aggregated SELECT columns to appear in GROUP BY</small>
            </span>
          </label>

          <label class="setting-row">
            <input
              type="checkbox"
              :checked="settings.strict"
              :disabled="disabled"
              @change="emit('toggle-strict', ($event.target as HTMLInputElement).checked)"
            />
            <span>
              <strong>Strict mode (STRICT_TRANS_TABLES)</strong>
              <small>Disable to observe silent type conversion warnings</small>
            </span>
          </label>

          <label class="setting-row">
            <input
              type="checkbox"
              :checked="settings.autocommit"
              :disabled="disabled"
              @change="emit('toggle-autocommit', ($event.target as HTMLInputElement).checked)"
            />
            <span>
              <strong>Autocommit</strong>
              <small><code>SET autocommit = 1/0</code></small>
            </span>
          </label>

          <label class="setting-select">
            <span><strong>Transaction isolation level</strong></span>
            <select
              :value="settings.isolation"
              :disabled="disabled"
              @change="
                emit(
                  'change-isolation',
                  ($event.target as HTMLSelectElement).value as IsolationLevel,
                )
              "
            >
              <option v-for="lvl in ISOLATION_LEVELS" :key="lvl" :value="lvl">
                {{ lvl }}
              </option>
            </select>
          </label>
        </section>

        <section class="setting-group">
          <h3>Appearance</h3>
          <label class="setting-select">
            <span><strong>Theme</strong></span>
            <select
              :value="settings.theme"
              @change="
                emit('change-theme', ($event.target as HTMLSelectElement).value as 'light' | 'dark')
              "
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </section>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  justify-content: flex-end;
}

.drawer-card {
  width: 360px;
  max-width: 92vw;
  height: 100%;
  background: var(--bg-surface);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.2);
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.drawer-header h2 {
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

.drawer-body {
  flex: 1;
  overflow: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.setting-group h3 {
  margin: 0 0 8px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.group-note {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-secondary);
}

.setting-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 10px;
  cursor: pointer;
}

.setting-row span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.setting-row small {
  color: var(--text-muted);
  font-size: 11.5px;
}

.setting-select {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.setting-select select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-surface);
}
</style>
