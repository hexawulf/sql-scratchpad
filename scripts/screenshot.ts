/**
 * scripts/screenshot.ts — reproducible README screenshot from the live site.
 *
 * Author: 0xWulf
 * Description: Opens SQL Scratchpad in a fresh light-theme Chromium context (1440x900),
 *   loads "Sample: Library", runs a 3-table JOIN in a new tab, waits for the 15-row result,
 *   screenshots the app root element to docs/screenshot.png, then deletes its workspace so it
 *   does not count against the per-IP workspace cap.
 * Usage: pnpm exec tsx scripts/screenshot.ts
 *   Env: SQLSCRATCHPAD_BASE_URL (default https://sql-scratchpad.com),
 *        SCREENSHOT_SCALE (deviceScaleFactor, default 2), SCREENSHOT_OUT (default docs/screenshot.png)
 *   Uses the Chromium already installed by Playwright; it never downloads browsers.
 * Modified: 2026-11-20
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.SQLSCRATCHPAD_BASE_URL ?? 'https://sql-scratchpad.com';
const scale = Number(process.env.SCREENSHOT_SCALE ?? '2');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(repoRoot, process.env.SCREENSHOT_OUT ?? 'docs/screenshot.png');

const QUERY = [
  'SELECT m.full_name, b.title, l.loaned_date, l.returned_date, l.late_fee',
  'FROM Loans l',
  'JOIN Members m USING (member_id)',
  'JOIN Books b USING (book_id)',
  'ORDER BY l.loaned_date;',
].join('\n');

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: scale,
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const wsIds = new Set<string>();
  page.on('response', async (res) => {
    if (res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/workspaces') {
      try {
        const body = (await res.json()) as { wsId?: string };
        if (body.wsId) wsIds.add(body.wsId);
      } catch {
        // ignore bodies of closed pages
      }
    }
  });

  try {
    await page.goto('/');
    await page.getByTestId('welcome-sample-btn').click();
    await expect(page.getByTestId('schema-tree')).toContainText('Loans');

    await page.getByTestId('add-tab-btn').click();
    await page.locator('[data-testid="sql-editor"] .cm-content').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(QUERY);
    await page.getByTestId('run-btn').click();

    await expect(page.getByTestId('status-log')).toContainText('Query finished');
    await expect(page.getByTestId('row-count-summary')).toContainText('Total rows loaded: 15');
    await expect(page.getByTestId('error-banner')).toHaveCount(0);

    // Move the caret off the editor so no blinking cursor or hover state ends up in the image.
    await page.mouse.move(0, 0);
    await page.locator('.app-root').screenshot({ path: out, animations: 'disabled' });
    console.log(`saved ${path.relative(repoRoot, out)} (scale ${scale})`);
  } finally {
    const stored = await page
      .evaluate(() => {
        try {
          // scripts/ is typechecked without the DOM lib, so reach localStorage through globalThis.
          const store = (
            globalThis as unknown as {
              localStorage: { getItem(key: string): string | null };
            }
          ).localStorage;
          const raw = store.getItem('sql-scratchpad:v1');
          return raw ? ((JSON.parse(raw) as { wsId?: string | null }).wsId ?? null) : null;
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (stored) wsIds.add(stored);
    for (const wsId of wsIds) {
      const res = await context.request.delete(`/api/workspaces/${wsId}`).catch(() => null);
      console.log(
        `closed workspace ${wsId.slice(0, 8)}… → ${res ? res.status() : 'request failed'}`,
      );
    }
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
