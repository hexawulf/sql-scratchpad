import { describe, expect, it, vi } from 'vitest';
import {
  ApiHttpError,
  MariaDbAdapter,
  WorkspaceExpiredError,
  parseRetryAfterSeconds,
} from './mariadb';

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

describe('MariaDbAdapter', () => {
  it('opens workspace, executes SQL, imports SQL, fetches schema, resets, kills, and closes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/workspaces' && method === 'POST') {
        return jsonResponse(201, {
          wsId: 'wsid12345678',
          database: 'ws_abcdef123456',
          expiresAt: '2026-11-20T00:00:00.000Z',
        });
      }
      if (url === '/api/workspaces/wsid12345678/exec' && method === 'POST') {
        return jsonResponse(200, {
          results: [{ index: 0, sql: 'SELECT 1', startLine: 1, kind: 'rows', rows: [[1]], durationMs: 1 }],
          txOpen: false,
        });
      }
      if (url === '/api/workspaces/wsid12345678/import' && method === 'POST') {
        return jsonResponse(200, {
          ok: true,
          mode: 'fresh',
          totalStatements: 2,
          statementsRun: 2,
          statementsOk: 2,
          skippedCount: 0,
          skipped: [],
          rewrittenCount: 0,
          rewritten: [],
          warningsCount: 0,
          durationMs: 12.5,
          tablesCreated: ['notes'],
        });
      }
      if (url === '/api/workspaces/wsid12345678/schema' && method === 'GET') {
        return jsonResponse(200, {
          database: 'ws_abcdef123456',
          engine: 'mariadb',
          tables: [],
          views: [],
        });
      }
      if (url === '/api/workspaces/wsid12345678/reset' && method === 'POST') {
        return jsonResponse(200, { database: 'ws_abcdef123456' });
      }
      if (url === '/api/workspaces/wsid12345678/sessions/A/kill' && method === 'POST') {
        return jsonResponse(200, { ok: true });
      }
      if (url === '/api/workspaces/wsid12345678' && method === 'DELETE') {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    });

    const adapter = new MariaDbAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });
    await adapter.open('sample-library');
    expect(adapter.getWorkspaceId()).toBe('wsid12345678');

    const execRes = await adapter.exec({ sql: 'SELECT 1;', session: 'A', stopOnError: true });
    expect(execRes.results).toHaveLength(1);

    const impRes = await adapter.importSql({ sql: 'CREATE TABLE notes (id INT);', mode: 'fresh' });
    expect(impRes.ok).toBe(true);
    expect(impRes.tablesCreated).toEqual(['notes']);

    const tree = await adapter.schema();
    expect(tree.database).toBe('ws_abcdef123456');

    await adapter.reset('empty');
    await adapter.kill('A');
    await adapter.close();
    expect(adapter.getWorkspaceId()).toBeNull();
  });

  it('throws WorkspaceExpiredError on 404 and ApiHttpError on 409', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(404, { error: { code: 'WORKSPACE_NOT_FOUND', message: 'Expired' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, { error: { code: 'SESSION_BUSY', message: 'Busy' } }),
      );

    const adapter = new MariaDbAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
      initialWsId: 'stalews12345',
    });

    await expect(adapter.schema()).rejects.toBeInstanceOf(WorkspaceExpiredError);
    await expect(
      adapter.exec({ sql: 'SELECT 1;', session: 'A', stopOnError: true }),
    ).rejects.toBeInstanceOf(ApiHttpError);
  });

  it('parses Retry-After header onto ApiHttpError for 429 and 503 responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          429,
          {
            error: {
              code: 'PER_IP_WORKSPACE_LIMIT',
              message: 'You have reached the maximum of 6 active workspaces per IP.',
            },
          },
          { 'retry-after': '7200' },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          503,
          {
            error: {
              code: 'WORKSPACE_LIMIT_REACHED',
              message: 'SQL Scratchpad is busy, try again in a few minutes',
            },
          },
          { 'retry-after': '180' },
        ),
      );

    const adapter = new MariaDbAdapter({ fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(adapter.open('empty')).rejects.toMatchObject({
      status: 429,
      code: 'PER_IP_WORKSPACE_LIMIT',
      retryAfterSec: 7200,
    });
    await expect(adapter.open('empty')).rejects.toMatchObject({
      status: 503,
      code: 'WORKSPACE_LIMIT_REACHED',
      retryAfterSec: 180,
    });
    expect(parseRetryAfterSeconds('120')).toBe(120);
    expect(parseRetryAfterSeconds('invalid')).toBeUndefined();
  });

  it('sends best-effort POST /close beacon and clears workspace state', () => {
    const beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: beaconSpy });
    try {
      const adapter = new MariaDbAdapter({
        initialWsId: 'wsbeacon1234',
        initialDatabase: 'ws_123456abcdef',
      });
      expect(adapter.closeWithBeacon()).toBe(true);
      expect(beaconSpy).toHaveBeenCalledWith('/api/workspaces/wsbeacon1234/close');
      expect(adapter.getWorkspaceId()).toBeNull();
      expect(adapter.getDatabase()).toBeNull();
      // Calling again is a no-op
      expect(adapter.closeWithBeacon()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
