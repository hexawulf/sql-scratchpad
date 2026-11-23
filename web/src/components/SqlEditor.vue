<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { MySQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { formatDialect, mariadb } from 'sql-formatter';
import type { SchemaTree } from '@sql-scratchpad/shared';
import { extractStatementAtCursor } from '../utils/sql-statement';

const props = defineProps<{
  modelValue: string;
  cursor?: number;
  schema: SchemaTree | null;
  errorLine: number | null;
  theme: 'light' | 'dark';
  running: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'update:cursor': [offset: number];
  'run-script': [sql: string, lineOffset: number];
  'run-statement': [sql: string, startLine: number];
  stop: [];
}>();

const hostEl = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;
let updatingFromProp = false;

const sqlCompartment = new Compartment();
const themeCompartment = new Compartment();

const setErrorLineEffect = StateEffect.define<number | null>();

const errorLineDecoration = Decoration.line({
  attributes: { class: 'cm-error-line', 'data-error-line': 'true' },
});

const errorLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setErrorLineEffect)) {
        const lineNum = effect.value;
        if (lineNum !== null && lineNum >= 1 && lineNum <= tr.state.doc.lines) {
          const line = tr.state.doc.line(lineNum);
          next = Decoration.set([errorLineDecoration.range(line.from)]);
        } else {
          next = Decoration.none;
        }
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function buildSqlNamespace(schema: SchemaTree | null): SQLNamespace | undefined {
  if (!schema) return undefined;
  const ns: Record<string, string[]> = {};
  for (const table of schema.tables) {
    ns[table.name] = table.columns.map((c) => c.name);
  }
  for (const v of schema.views) {
    if (!ns[v.name]) ns[v.name] = [];
  }
  return ns;
}

function buildSqlExtension(schema: SchemaTree | null) {
  return sql({
    dialect: MySQL,
    schema: buildSqlNamespace(schema),
    upperCaseKeywords: true,
  });
}

function buildThemeExtension(theme: 'light' | 'dark') {
  const isDark = theme === 'dark';
  return [
    EditorView.theme(
      {
        '&': {
          height: '100%',
          fontSize: '13px',
          fontFamily: 'var(--font-mono)',
          backgroundColor: 'var(--bg-surface)',
          color: 'var(--text-primary)',
        },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: 'var(--font-mono)',
        },
        '.cm-content': {
          caretColor: 'var(--accent)',
          padding: '6px 0',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--bg-header)',
          color: 'var(--text-muted)',
          borderRight: '1px solid var(--border-subtle)',
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'var(--bg-subtle)',
          color: 'var(--text-primary)',
        },
        '.cm-activeLine': {
          backgroundColor: isDark ? 'rgba(20, 184, 166, 0.08)' : 'rgba(13, 148, 136, 0.05)',
        },
        '.cm-error-line': {
          backgroundColor: 'var(--error-line-bg)',
          textDecoration: 'underline wavy var(--danger)',
        },
        '.cm-tooltip': {
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
        },
        '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
          backgroundColor: 'var(--accent-fill)',
          color: 'var(--accent-text)',
        },
        ...(isDark
          ? {
              '.cm-line span': {
                filter: 'brightness(1.75) saturate(1.15)',
              },
            }
          : {}),
      },
      { dark: isDark },
    ),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  ];
}

function runSelectionOrScript(): boolean {
  if (!view) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) {
    const selectedText = view.state.sliceDoc(sel.from, sel.to);
    const startLine = view.state.doc.lineAt(sel.from).number;
    emit('run-script', selectedText, startLine - 1);
  } else {
    emit('run-script', view.state.doc.toString(), 0);
  }
  return true;
}

function runCurrentStatement(): boolean {
  if (!view) return false;
  const docText = view.state.doc.toString();
  const offset = view.state.selection.main.head;
  const stmt = extractStatementAtCursor(docText, offset);
  if (!stmt) return true;
  emit('run-statement', stmt.sql, stmt.startLine);
  return true;
}

function formatDocument(): boolean {
  if (!view) return false;
  const raw = view.state.doc.toString();
  if (!raw.trim()) return true;
  try {
    const formatted = formatDialect(raw, {
      dialect: mariadb,
      keywordCase: 'upper',
      tabWidth: 2,
    });
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
    });
  } catch {
    // Keep original SQL if formatter cannot parse incomplete syntax
  }
  return true;
}

function insertText(text: string): void {
  if (!view) return;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
  });
  view.focus();
}

function getRunPayload(): { sql: string; lineOffset: number } {
  if (!view) return { sql: props.modelValue, lineOffset: 0 };
  const sel = view.state.selection.main;
  if (!sel.empty) {
    return {
      sql: view.state.sliceDoc(sel.from, sel.to),
      lineOffset: view.state.doc.lineAt(sel.from).number - 1,
    };
  }
  return { sql: view.state.doc.toString(), lineOffset: 0 };
}

function getStatementPayload(): { sql: string; startLine: number } | null {
  const docText = view ? view.state.doc.toString() : props.modelValue;
  const offset = view ? view.state.selection.main.head : (props.cursor ?? 0);
  const stmt = extractStatementAtCursor(docText, offset);
  return stmt ? { sql: stmt.sql, startLine: stmt.startLine } : null;
}

defineExpose({
  formatDocument,
  insertText,
  getRunPayload,
  getStatementPayload,
  focus: () => view?.focus(),
});

onMounted(() => {
  if (!hostEl.value) return;

  const customKeymap = keymap.of([
    { key: 'F9', run: () => runSelectionOrScript() },
    { key: 'Mod-Shift-Enter', run: () => runSelectionOrScript() },
    { key: 'Mod-Enter', run: () => runCurrentStatement() },
    { key: 'Mod-/', run: toggleComment },
    { key: 'Mod-Shift-f', run: () => formatDocument() },
    {
      key: 'Escape',
      run: () => {
        if (props.running) {
          emit('stop');
          return true;
        }
        return false;
      },
    },
  ]);

  const initialCursor = Math.min(props.cursor ?? 0, props.modelValue.length);

  const state = EditorState.create({
    doc: props.modelValue,
    selection: { anchor: initialCursor },
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      autocompletion(),
      errorLineField,
      sqlCompartment.of(buildSqlExtension(props.schema)),
      themeCompartment.of(buildThemeExtension(props.theme)),
      customKeymap,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (updatingFromProp) return;
        if (update.docChanged) {
          emit('update:modelValue', update.state.doc.toString());
        }
        if (update.selectionSet || update.docChanged) {
          emit('update:cursor', update.state.selection.main.head);
        }
      }),
    ],
  });

  view = new EditorView({
    state,
    parent: hostEl.value,
  });

  if (props.errorLine !== null) {
    view.dispatch({ effects: setErrorLineEffect.of(props.errorLine) });
  }
});

watch(
  () => props.modelValue,
  (nextValue) => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === nextValue) return;
    updatingFromProp = true;
    const targetCursor = Math.min(props.cursor ?? 0, nextValue.length);
    view.dispatch({
      changes: { from: 0, to: current.length, insert: nextValue },
      selection: { anchor: targetCursor },
    });
    updatingFromProp = false;
  },
);

watch(
  () => props.schema,
  (nextSchema) => {
    if (!view) return;
    view.dispatch({
      effects: sqlCompartment.reconfigure(buildSqlExtension(nextSchema)),
    });
  },
);

watch(
  () => props.theme,
  (nextTheme) => {
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(buildThemeExtension(nextTheme)),
    });
  },
);

watch(
  () => props.errorLine,
  (lineNum) => {
    if (!view) return;
    view.dispatch({
      effects: setErrorLineEffect.of(lineNum),
    });
    if (lineNum !== null && lineNum >= 1 && lineNum <= view.state.doc.lines) {
      const line = view.state.doc.line(lineNum);
      view.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
    }
  },
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="hostEl" class="sql-editor-host" data-testid="sql-editor" />
</template>

<style scoped>
.sql-editor-host {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
