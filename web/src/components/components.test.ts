import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { SchemaTree as SchemaTreeData } from '@sql-scratchpad/shared';
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
    expect(wrapper.get('[data-testid="about-version"]').text()).toContain('Version 0.2.0 · build testsha');
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
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
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
});
