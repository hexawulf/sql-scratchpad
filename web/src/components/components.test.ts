import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { SchemaTree as SchemaTreeData } from '@sql-scratchpad/shared';
import App from '../App.vue';
import StatusLog from './StatusLog.vue';
import ResultGrid from './ResultGrid.vue';
import SchemaTree from './SchemaTree.vue';
import TabBar from './TabBar.vue';
import SettingsDrawer from './SettingsDrawer.vue';
import AboutModal from './AboutModal.vue';
import ImportModal from './ImportModal.vue';
import MessagesPanel from './MessagesPanel.vue';
import { createDefaultSettings } from '../utils/storage';

describe('Vue components', () => {
  it('StatusLog renders Letos lines, error/warning classes, and emits clear', async () => {
    const wrapper = mount(StatusLog, {
      props: {
        entries: [
          {
            id: 1,
            timestamp: '10:48:53',
            level: 'info',
            message: '[10:48:53] Query finished in 0.05026 second(s). Rows affected: 31',
          },
          {
            id: 2,
            timestamp: '10:48:54',
            level: 'error',
            message: '[10:48:54] ERROR 1064 (42000): Syntax error',
          },
        ],
      },
    });
    expect(wrapper.text()).toContain('Query finished in 0.05026 second(s). Rows affected: 31');
    expect(wrapper.find('.level-error').text()).toContain('ERROR 1064');
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('clear')).toHaveLength(1);
  });

  it('ResultGrid renders row count, truncated notice, and escapes HTML in cells', () => {
    const wrapper = mount(ResultGrid, {
      props: {
        columns: [
          { name: 'Name', type: 'VARCHAR' },
          { name: 'Population', type: 'INT' },
        ],
        rows: [
          ['<script>alert(1)</script>', 500],
          [null, 1000],
        ],
        truncated: true,
      },
    });
    expect(wrapper.get('[data-testid="row-count-summary"]').text()).toContain(
      'Total rows loaded: 2',
    );
    expect(wrapper.get('[data-testid="truncated-notice"]').text()).toContain('truncated at 2');
    expect(wrapper.find('script').exists()).toBe(false);
  });

  it('SchemaTree renders database, tables, columns with PK/FK badges, and views', () => {
    const tree: SchemaTreeData = {
      database: 'ws_1234567890ab',
      engine: 'mariadb',
      tables: [
        {
          name: 'Loans',
          columns: [
            {
              name: 'loan_id',
              type: 'int(11)',
              nullable: false,
              key: 'PRI',
              default: null,
              extra: '',
            },
            {
              name: 'book_id',
              type: 'int(11)',
              nullable: false,
              key: 'MUL',
              default: null,
              extra: '',
            },
          ],
          indexes: [{ name: 'PRIMARY', columns: ['loan_id'], unique: true }],
          foreignKeys: [
            {
              name: 'fk_loans_book',
              columns: ['book_id'],
              refTable: 'Books',
              refColumns: ['book_id'],
              onDelete: 'RESTRICT',
              onUpdate: 'RESTRICT',
            },
          ],
          triggers: [],
        },
      ],
      views: [{ name: 'ActiveLoans' }],
    };

    const wrapper = mount(SchemaTree, { props: { schema: tree, loading: false } });
    expect(wrapper.text()).toContain('ws_1234567890ab');
    expect(wrapper.text()).toContain('MariaDB 11.4');
    expect(wrapper.text()).toContain('loan_id : int(11)');
    expect(wrapper.find('.key-badge.pk').exists()).toBe(true);
    expect(wrapper.find('.key-badge.fk').exists()).toBe(true);
    expect(wrapper.text()).toContain('ActiveLoans');
  });

  it('TabBar renders tab title and emits add/select', async () => {
    const wrapper = mount(TabBar, {
      props: {
        tabs: [{ id: 't1', title: 'query_1.sql', sql: 'SELECT 1;', cursor: 0 }],
        activeTabId: 't1',
      },
    });
    expect(wrapper.text()).toContain('query_1.sql');
    await wrapper.get('[data-testid="add-tab-btn"]').trigger('click');
    expect(wrapper.emitted('add')).toHaveLength(1);
  });

  it('SettingsDrawer renders all PLAN §7.1 toggles', () => {
    const wrapper = mount(SettingsDrawer, {
      props: {
        open: true,
        settings: createDefaultSettings(),
        disabled: false,
      },
    });
    expect(wrapper.text()).toContain('Safe Update Mode');
    expect(wrapper.text()).toContain('ONLY_FULL_GROUP_BY');
    expect(wrapper.text()).toContain('STRICT_TRANS_TABLES');
    expect(wrapper.text()).toContain('Transaction isolation level');
    expect(wrapper.text()).toContain('Autocommit');
  });

  it('AboutModal renders metadata, safe external links, closes on Esc/backdrop, and traps focus', async () => {
    const wrapper = mount(AboutModal, {
      attachTo: document.body,
      props: { open: true },
    });

    expect(wrapper.text()).toContain(
      'SQL Scratchpad — a Letos-style SQL playground (MariaDB + SQLite)',
    );
    expect(wrapper.get('[data-testid="about-version"]').text()).toContain(
      'Version 0.0.0-test · build testsha',
    );
    expect(wrapper.text()).toContain('Erling Wulf Weinreich (0xWulf)');
    expect(wrapper.text()).toContain('MariaDB, sql.js (SQLite), Vue 3, CodeMirror 6, Fastify');
    expect(wrapper.text()).toContain('Not affiliated with any university.');
    expect(wrapper.get('[data-testid="about-privacy"]').text()).toContain(
      'No accounts, no analytics, and no SQL logged.',
    );

    const emailLink = wrapper.get('[data-testid="about-email-link"]');
    expect(emailLink.attributes('href')).toBe('mailto:dev@0xwulf.dev');
    expect(emailLink.attributes('target')).toBe('_blank');
    expect(emailLink.attributes('rel')).toBe('noopener noreferrer');

    const sourceLink = wrapper.get('[data-testid="about-source-link"]');
    expect(sourceLink.attributes('href')).toBe('https://github.com/hexawulf/sql-scratchpad');
    expect(sourceLink.attributes('target')).toBe('_blank');
    expect(sourceLink.attributes('rel')).toBe('noopener noreferrer');

    const sisterLink = wrapper.get('[data-testid="about-sister-link"]');
    expect(sisterLink.text()).toBe('py-scratchpad.com');
    expect(sisterLink.attributes('href')).toBe('https://py-scratchpad.com');
    expect(sisterLink.attributes('target')).toBe('_blank');
    expect(sisterLink.attributes('rel')).toBe('noopener noreferrer');

    // Focus trap: Shift+Tab on first focusable wraps to last; Tab on last wraps to first
    const closeBtn = wrapper.get('[data-testid="about-close-btn"]').element as HTMLElement;
    const lastLink = sisterLink.element as HTMLElement;
    closeBtn.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(lastLink);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).toBe(closeBtn);

    // Esc closes modal
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);

    // Click outside (backdrop) closes modal
    await wrapper.get('[data-testid="about-backdrop"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(2);

    wrapper.unmount();
  });

  it('ImportModal defaults to fresh mode, allows switching to append, and blocks >6 MB files', async () => {
    const wrapper = mount(ImportModal, {
      props: {
        open: true,
        fileName: 'schema.sql',
        fileSizeBytes: 2048,
        importing: false,
        errorMessage: null,
      },
    });
    expect(wrapper.text()).toContain('schema.sql');
    expect(wrapper.text()).toContain('2.0 KB');
    await wrapper.get('[data-testid="import-mode-append"]').setValue();
    await wrapper.get('[data-testid="import-confirm-btn"]').trigger('click');
    expect(wrapper.emitted('confirm')).toEqual([['append']]);

    const hugeWrapper = mount(ImportModal, {
      props: {
        open: true,
        fileName: 'huge.sql',
        fileSizeBytes: 7 * 1024 * 1024,
        importing: false,
        errorMessage: null,
      },
    });
    expect(hugeWrapper.text()).toContain('6 MB');
    expect(
      (hugeWrapper.get('[data-testid="import-confirm-btn"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('ImportModal shows query-only notice with Open in editor and Import anyway actions', async () => {
    const wrapper = mount(ImportModal, {
      props: {
        open: true,
        fileName: 'Unit2_Select.sql',
        fileSizeBytes: 512,
        importing: false,
        errorMessage: null,
        isQueryOnly: true,
        canOpenInEditor: true,
      },
    });

    expect(wrapper.get('[data-testid="import-query-only-notice"]').text()).toMatch(
      /query script|read-only/i,
    );
    await wrapper.get('[data-testid="import-open-editor-btn"]').trigger('click');
    expect(wrapper.emitted('open-in-editor')).toHaveLength(1);

    await wrapper.get('[data-testid="import-anyway-btn"]').trigger('click');
    expect(wrapper.emitted('confirm')).toEqual([['fresh']]);
  });

  it('MessagesPanel renders 1146 error hint and Open in editor button on failed import card', async () => {
    const wrapper = mount(MessagesPanel, {
      props: {
        results: [],
        importSummary: {
          fileName: 'Unit2_Select.sql',
          sqlText: 'SELECT * FROM Country;\n',
          response: {
            ok: false,
            mode: 'append',
            totalStatements: 1,
            statementsRun: 1,
            statementsOk: 0,
            skippedCount: 0,
            skipped: [],
            rewrittenCount: 0,
            rewritten: [],
            warningsCount: 0,
            durationMs: 3.1,
            tablesCreated: [],
            error: {
              index: 0,
              startLine: 3,
              code: 'ER_NO_SUCH_TABLE',
              errno: 1146,
              sqlState: '42S02',
              message: "Table 'ws_abc.Country' doesn't exist",
              alreadyApplied: false,
              hint: "Current dataset is 'empty'. This script references a table that doesn't exist — it may be a query script. Open it in an editor tab instead, or import the schema script first.",
            },
          },
        },
      },
    });

    expect(wrapper.get('[data-testid="import-error-hint"]').text()).toContain(
      "Current dataset is 'empty'",
    );
    await wrapper.get('[data-testid="import-error-open-editor-btn"]').trigger('click');
    expect(wrapper.emitted('open-in-editor')).toEqual([
      ['Unit2_Select.sql', 'SELECT * FROM Country;\n'],
    ]);
  });

  it('MessagesPanel renders import summary with skipped and rewritten counts', () => {
    const wrapper = mount(MessagesPanel, {
      props: {
        results: [],
        importSummary: {
          fileName: 'dump.sql',
          response: {
            ok: true,
            mode: 'fresh',
            totalStatements: 5,
            statementsRun: 3,
            statementsOk: 3,
            skippedCount: 2,
            skipped: [
              { index: 0, startLine: 1, reason: 'USE <database> skipped', snippet: 'USE demo' },
            ],
            rewrittenCount: 1,
            rewritten: [
              {
                index: 2,
                startLine: 5,
                reason: 'Stripped DEFINER clause',
                snippet: 'CREATE DEFINER=`root`@`localhost` VIEW v AS SELECT 1',
              },
            ],
            warningsCount: 0,
            durationMs: 42.5,
            tablesCreated: ['items'],
          },
        },
      },
    });

    const card = wrapper.get('[data-testid="import-summary-card"]');
    expect(card.text()).toContain('dump.sql');
    expect(card.text()).toContain('Skipped: 2');
    expect(card.text()).toContain('Rewritten: 1');
    expect(card.text()).toContain('items');
  });

  it('SchemaTree renders workspace error instead of "No workspace connected."', () => {
    const wrapper = mount(SchemaTree, {
      props: {
        schema: null,
        loading: false,
        error:
          'You have reached the maximum of 6 active workspaces per IP. Please try again in 120 minutes.',
      },
    });
    expect(wrapper.get('[data-testid="schema-tree-error"]').text()).toContain(
      'try again in 120 minutes',
    );
    expect(wrapper.text()).not.toContain('No workspace connected.');
  });
});

function makeJsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const SqlEditorStub = {
  name: 'SqlEditor',
  props: ['modelValue', 'cursor', 'schema', 'errorLine', 'theme', 'running'],
  template: '<div data-testid="sql-editor-stub">{{ modelValue }}</div>',
  methods: {
    getRunPayload() {
      return { sql: (this as unknown as { modelValue: string }).modelValue, lineOffset: 0 };
    },
    getStatementPayload() {
      return { sql: (this as unknown as { modelValue: string }).modelValue, startLine: 1 };
    },
    insertText() {},
    formatDocument() {},
  },
};

describe('App workspace lifecycle and 429/503 error UX', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('surfaces 429 create/reset/exec/import errors in banner, status log, and schema tree (never silent "No workspace connected.")', async () => {
    window.localStorage.clear();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/health') {
        return makeJsonResponse(200, { status: 'ok', db: 'ok', version: '0.3.6' });
      }
      if (url === '/api/datasets') {
        return makeJsonResponse(200, [
          {
            id: 'sample-library',
            title: 'Sample: Library',
            description: '',
            tables: [],
            engines: ['mariadb'],
          },
          { id: 'empty', title: 'Empty', description: '', tables: [], engines: ['mariadb'] },
        ]);
      }
      if (url === '/api/workspaces' && method === 'POST') {
        return makeJsonResponse(
          429,
          {
            error: {
              code: 'PER_IP_WORKSPACE_LIMIT',
              message:
                'You have reached the maximum of 6 active workspaces per IP. Close a workspace or wait for it to expire.',
            },
          },
          { 'retry-after': '7200' },
        );
      }
      return makeJsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    });

    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(App, {
      global: {
        stubs: { SqlEditor: SqlEditorStub },
      },
    });

    await flushPromises();

    // Visible alert banner shows server message + Retry-After in minutes
    const banner = wrapper.get('[data-testid="error-banner"]');
    expect(banner.text()).toContain('maximum of 6 active workspaces per IP');
    expect(banner.text()).toContain('try again in 120 minutes');

    // Status log shows the same error + Retry-After
    const statusLog = wrapper.get('[data-testid="status-log"]');
    expect(statusLog.text()).toContain('maximum of 6 active workspaces per IP');
    expect(statusLog.text()).toContain('try again in 120 minutes');

    // Schema tree shows the error rather than falling back silently to "No workspace connected."
    const tree = wrapper.get('[data-testid="schema-tree"]');
    expect(tree.get('[data-testid="schema-tree-error"]').text()).toContain(
      'try again in 120 minutes',
    );
    expect(tree.text()).not.toContain('No workspace connected.');

    wrapper.unmount();
  });

  it('reuses one workspace via POST /reset across Sample: Library, Empty DB, and dataset switches, and calls sendBeacon /close on pagehide', async () => {
    window.localStorage.clear();

    const calls: Array<{ method: string; url: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });

      if (url === '/api/health') {
        return makeJsonResponse(200, { status: 'ok', db: 'ok', version: '0.3.6' });
      }
      if (url === '/api/datasets') {
        return makeJsonResponse(200, [
          {
            id: 'sample-library',
            title: 'Sample: Library',
            description: '',
            tables: [],
            engines: ['mariadb'],
          },
          { id: 'empty', title: 'Empty', description: '', tables: [], engines: ['mariadb'] },
        ]);
      }
      if (url === '/api/workspaces' && method === 'POST') {
        return makeJsonResponse(201, {
          wsId: 'wsreuse123456',
          database: 'ws_112233445566',
          expiresAt: '2026-11-20T12:00:00.000Z',
        });
      }
      if (url === '/api/workspaces/wsreuse123456/schema' && method === 'GET') {
        return makeJsonResponse(200, {
          database: 'ws_112233445566',
          engine: 'mariadb',
          tables: [],
          views: [],
        });
      }
      if (url === '/api/workspaces/wsreuse123456/reset' && method === 'POST') {
        return makeJsonResponse(200, { database: 'ws_112233445566' });
      }
      if (url === '/api/workspaces/wsreuse123456/exec' && method === 'POST') {
        return makeJsonResponse(
          503,
          {
            error: {
              code: 'WORKSPACE_LIMIT_REACHED',
              message: 'SQL Scratchpad is busy, try again in a few minutes',
            },
          },
          { 'retry-after': '180' },
        );
      }
      return makeJsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    });

    const beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { sendBeacon: beaconSpy });

    const wrapper = mount(App, {
      global: {
        stubs: { SqlEditor: SqlEditorStub },
      },
    });
    await flushPromises();

    // Click "Sample: Library" -> must POST /reset, NOT create a second workspace
    await wrapper.get('[data-testid="welcome-sample-btn"]').trigger('click');
    await flushPromises();

    // Switch dataset dropdown to empty -> must POST /reset
    await wrapper.get('[data-testid="dataset-select"]').setValue('empty');
    await flushPromises();

    // Trigger 503 on exec -> must surface error banner with Retry-After minutes
    await wrapper.get('[data-testid="run-btn"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="error-banner"]').text()).toContain('SQL Scratchpad is busy');
    expect(wrapper.get('[data-testid="error-banner"]').text()).toContain('try again in 3 minutes');

    const createCalls = calls.filter((c) => c.method === 'POST' && c.url === '/api/workspaces');
    const resetCalls = calls.filter(
      (c) => c.method === 'POST' && c.url === '/api/workspaces/wsreuse123456/reset',
    );
    expect(createCalls).toHaveLength(1);
    expect(resetCalls).toHaveLength(2);

    // pagehide frees slot via navigator.sendBeacon to /api/workspaces/:wsId/close
    window.dispatchEvent(new Event('pagehide'));
    expect(beaconSpy).toHaveBeenCalledWith('/api/workspaces/wsreuse123456/close');

    wrapper.unmount();
  });

  it('clears the previous Messages card when alternating between Run and Import, and opens query-only file in editor without calling /import', async () => {
    window.localStorage.clear();

    const calls: Array<{ method: string; url: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });

      if (url === '/api/health') {
        return makeJsonResponse(200, { status: 'ok', db: 'ok', version: '0.3.6' });
      }
      if (url === '/api/datasets') {
        return makeJsonResponse(200, [
          {
            id: 'sample-library',
            title: 'Sample: Library',
            description: '',
            tables: [],
            engines: ['mariadb'],
          },
          { id: 'empty', title: 'Empty', description: '', tables: [], engines: ['mariadb'] },
        ]);
      }
      if (url === '/api/workspaces' && method === 'POST') {
        return makeJsonResponse(201, {
          wsId: 'wsmsgclear123',
          database: 'ws_aabbccddeeff',
          expiresAt: '2026-11-20T12:00:00.000Z',
        });
      }
      if (url === '/api/workspaces/wsmsgclear123/schema' && method === 'GET') {
        return makeJsonResponse(200, {
          database: 'ws_aabbccddeeff',
          engine: 'mariadb',
          tables: [],
          views: [],
        });
      }
      if (url === '/api/workspaces/wsmsgclear123/exec' && method === 'POST') {
        return makeJsonResponse(200, {
          results: [
            {
              index: 0,
              sql: 'SELECT * FROM Country',
              startLine: 1,
              kind: 'error',
              error: {
                code: 'ER_NO_SUCH_TABLE',
                errno: 1146,
                sqlState: '42S02',
                message: "Table 'ws_aabbccddeeff.Country' doesn't exist",
              },
              durationMs: 1.5,
            },
          ],
          txOpen: false,
        });
      }
      if (url === '/api/workspaces/wsmsgclear123/import' && method === 'POST') {
        return makeJsonResponse(200, {
          ok: true,
          mode: 'fresh',
          totalStatements: 1,
          statementsRun: 1,
          statementsOk: 1,
          skippedCount: 0,
          skipped: [],
          rewrittenCount: 0,
          rewritten: [],
          warningsCount: 0,
          durationMs: 4.2,
          tablesCreated: ['notes'],
        });
      }
      return makeJsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    });

    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(App, {
      global: {
        stubs: { SqlEditor: SqlEditorStub },
      },
    });
    await flushPromises();

    // 1. Selecting a query-only file shows query-only notice; clicking Open in editor loads tab & never hits /import
    const queryFile = new File(['-- lesson\nSELECT * FROM Country;\n'], 'lesson.sql', {
      type: 'application/sql',
    });
    const fileInput = wrapper.get('[data-testid="import-file-input"]').element as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { value: [queryFile], configurable: true });
    await wrapper.get('[data-testid="import-file-input"]').trigger('change');
    await flushPromises();

    expect(wrapper.find('[data-testid="import-query-only-notice"]').exists()).toBe(true);
    await wrapper.get('[data-testid="import-open-editor-btn"]').trigger('click');
    await flushPromises();

    expect(calls.filter((c) => c.url.endsWith('/import'))).toHaveLength(0);
    expect(wrapper.get('[data-testid="tab-bar"]').text()).toContain('lesson.sql');

    // 2. Run script -> Messages shows only the Run result card (no import card)
    await wrapper.get('[data-testid="run-btn"]').trigger('click');
    await flushPromises();

    let messagesPanel = wrapper.get('[data-testid="messages-panel"]');
    expect(messagesPanel.find('[data-testid="import-summary-card"]').exists()).toBe(false);
    expect(messagesPanel.text()).toContain("Table 'ws_aabbccddeeff.Country' doesn't exist");

    // 3. Import a real DDL file -> Messages shows ONLY the Import summary card (previous Run card cleared)
    const ddlFile = new File(['CREATE TABLE notes (id INT PRIMARY KEY);\n'], 'schema.sql', {
      type: 'application/sql',
    });
    Object.defineProperty(fileInput, 'files', { value: [ddlFile], configurable: true });
    await wrapper.get('[data-testid="import-file-input"]').trigger('change');
    await flushPromises();

    await wrapper.get('[data-testid="import-confirm-btn"]').trigger('click');
    await flushPromises();

    messagesPanel = wrapper.get('[data-testid="messages-panel"]');
    expect(messagesPanel.find('[data-testid="import-summary-card"]').exists()).toBe(true);
    expect(messagesPanel.text()).not.toContain("Table 'ws_aabbccddeeff.Country' doesn't exist");

    // 4. Run again -> previous Import summary card is cleared
    await wrapper.get('[data-testid="run-btn"]').trigger('click');
    await flushPromises();

    messagesPanel = wrapper.get('[data-testid="messages-panel"]');
    expect(messagesPanel.find('[data-testid="import-summary-card"]').exists()).toBe(false);
    expect(messagesPanel.text()).toContain("Table 'ws_aabbccddeeff.Country' doesn't exist");

    wrapper.unmount();
  });
});
