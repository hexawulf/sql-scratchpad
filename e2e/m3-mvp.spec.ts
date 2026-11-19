import { expect, test } from '@playwright/test';

test.describe('SQL Scratchpad public app acceptance flows', () => {
  let trackedWsIds: Set<string>;
  let pageCreatedCount: number;

  test.beforeEach(({ page }) => {
    trackedWsIds = new Set<string>();
    pageCreatedCount = 0;

    page.on('response', async (res) => {
      if (res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/workspaces') {
        if (res.status() === 201) {
          pageCreatedCount += 1;
          try {
            const body = (await res.json()) as { wsId?: string };
            if (body.wsId) trackedWsIds.add(body.wsId);
          } catch {
            // Ignore body parse errors on closed page
          }
        }
      }
    });
  });

  test.afterEach(async ({ page, request }) => {
    const storedWsId = await page
      .evaluate(() => {
        try {
          const raw = window.localStorage.getItem('sql-scratchpad:v1');
          if (!raw) return null;
          const parsed = JSON.parse(raw) as { wsId?: string | null };
          return parsed.wsId ?? null;
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (storedWsId) trackedWsIds.add(storedWsId);

    for (const wsId of [...trackedWsIds]) {
      trackedWsIds.delete(wsId);
      await request.delete(`/api/workspaces/${wsId}`).catch(() => {});
    }
  });

  test('new user sees empty state, loads Sample: Library, runs SELECT * FROM Books (12 rows)', async ({
    page,
  }) => {
    await page.goto('/');

    // Empty state for new users with 3 actions
    await expect(page.getByTestId('welcome-empty-state')).toBeVisible();
    await expect(page.getByTestId('welcome-empty-btn')).toBeVisible();
    await expect(page.getByTestId('welcome-sample-btn')).toBeVisible();
    await expect(page.getByTestId('welcome-import-btn')).toBeVisible();

    // Load Sample: Library (reuses current workspace via /reset, never creates a second one)
    await page.getByTestId('welcome-sample-btn').click();
    await expect(page.getByTestId('schema-tree')).toContainText('Books');
    await expect(page.getByTestId('schema-tree')).toContainText('Authors');
    expect(pageCreatedCount).toBe(1);

    // Run starter query (SELECT * FROM Books;)
    await page.getByTestId('run-btn').click();
    await expect(page.getByTestId('status-log')).toContainText('Query finished in');
    await expect(page.getByTestId('row-count-summary')).toContainText('Total rows loaded: 12');
    await expect(page.getByTestId('result-grid')).toContainText('Foundations of Relational Storage');
  });

  test('syntax error highlights the failing line in the editor and logs ERROR in status log', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('welcome-sample-btn').click();
    await expect(page.getByTestId('schema-tree')).toContainText('Books');

    await page.getByTestId('add-tab-btn').click();
    const editor = page.locator('[data-testid="sql-editor"] .cm-content');
    await editor.click();
    await page.keyboard.type('SELECT 1;\nSELEC * FROM Books;');
    await page.getByTestId('run-btn').click();

    await expect(page.getByTestId('status-log')).toContainText('ERROR 1064');
    await expect(
      page.locator('[data-testid="sql-editor"] .cm-error-line[data-error-line="true"]'),
    ).toBeVisible();
  });

  test('imports a .sql file via file input and refreshes schema tree', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('import-file-input').setInputFiles({
      name: 'demo.sql',
      mimeType: 'application/sql',
      buffer: Buffer.from(
        'CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(80));\nINSERT INTO notes VALUES (1, \'imported\');\n',
      ),
    });

    await expect(page.getByTestId('import-modal')).toBeVisible();
    await page.getByTestId('import-confirm-btn').click();

    await expect(page.getByTestId('import-summary-card')).toContainText('demo.sql');
    await expect(page.getByTestId('schema-tree')).toContainText('notes');
    expect(pageCreatedCount).toBe(1);
  });

  test('reload restores tabs and execution history from sql-scratchpad:v1', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('welcome-sample-btn').click();
    await expect(page.getByTestId('schema-tree')).toContainText('Books');

    await page.getByTestId('add-tab-btn').click();
    const editor = page.locator('[data-testid="sql-editor"] .cm-content');
    await editor.click();
    await page.keyboard.type('SELECT COUNT(*) AS cnt FROM Books;');
    await page.getByTestId('run-btn').click();
    await expect(page.getByTestId('row-count-summary')).toContainText('Total rows loaded: 1');

    await page.reload();
    await expect(page.getByTestId('schema-tree')).toContainText('Books');
    await expect(page.getByTestId('tab-bar')).toContainText('query_2.sql');
    await page.getByTestId('history-tab-btn').click();
    await expect(page.getByTestId('history-panel')).toContainText(
      'SELECT COUNT(*) AS cnt FROM Books;',
    );
  });

  test('hitting the per-IP workspace cap surfaces a visible 429 banner, status log, and schema error', async ({
    page,
    request,
  }) => {
    // Fill all 6 default per-IP live workspace slots from this IP
    for (let i = 0; i < 6; i += 1) {
      const res = await request.post('/api/workspaces', { data: { dataset: 'empty' } });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as { wsId: string };
      trackedWsIds.add(body.wsId);
    }

    await page.goto('/');

    const banner = page.getByTestId('error-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('maximum of 6 active workspaces per IP');
    await expect(banner).toContainText(/try again in \d+ minutes?/i);

    await expect(page.getByTestId('status-log')).toContainText(
      'maximum of 6 active workspaces per IP',
    );
    await expect(page.getByTestId('status-log')).toContainText(/try again in \d+ minutes?/i);

    // Schema tree must show the error instead of silently falling back to "No workspace connected."
    await expect(page.getByTestId('schema-tree-error')).toBeVisible();
    await expect(page.getByTestId('schema-tree')).not.toContainText('No workspace connected.');
  });
});
