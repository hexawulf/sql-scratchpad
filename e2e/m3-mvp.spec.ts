import { expect, test } from '@playwright/test';

test.describe('SQLyard public app acceptance flows', () => {
  test('new user sees empty state, loads Sample: Library, runs SELECT * FROM Books (12 rows)', async ({
    page,
  }) => {
    await page.goto('/');

    // Empty state for new users with 3 actions
    await expect(page.getByTestId('welcome-empty-state')).toBeVisible();
    await expect(page.getByTestId('welcome-empty-btn')).toBeVisible();
    await expect(page.getByTestId('welcome-sample-btn')).toBeVisible();
    await expect(page.getByTestId('welcome-import-btn')).toBeVisible();

    // Load Sample: Library
    await page.getByTestId('welcome-sample-btn').click();
    await expect(page.getByTestId('schema-tree')).toContainText('Books');
    await expect(page.getByTestId('schema-tree')).toContainText('Authors');

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
  });

  test('reload restores tabs and execution history from sqlyard:v1', async ({ page }) => {
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
    await expect(page.getByTestId('tab-bar')).toContainText('query_2.sql');
    await page.getByTestId('history-tab-btn').click();
    await expect(page.getByTestId('history-panel')).toContainText(
      'SELECT COUNT(*) AS cnt FROM Books;',
    );
  });
});
