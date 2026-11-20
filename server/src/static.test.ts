import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSP_HEADER, registerStaticSpa } from './static.js';

describe('registerStaticSpa', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sql-scratchpad-static-'));
    mkdirSync(join(tempDir, 'assets'), { recursive: true });
    mkdirSync(join(tempDir, '.git'), { recursive: true });
    writeFileSync(
      join(tempDir, 'index.html'),
      '<!doctype html><html><body>SQL Scratchpad</body></html>',
    );
    writeFileSync(
      join(tempDir, 'favicon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"></svg>',
    );
    writeFileSync(join(tempDir, 'favicon.ico'), Buffer.from([0x00, 0x00, 0x01, 0x00]));
    writeFileSync(
      join(tempDir, 'apple-touch-icon.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    writeFileSync(join(tempDir, 'assets', 'app-abc123.js'), 'console.log("ok");');
    writeFileSync(join(tempDir, '.env'), 'SECRET=shouldnotserve\n');
    writeFileSync(join(tempDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    writeFileSync(join(tempDir, 'assets', '.hidden'), 'TOPSECRET\n');
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves index.html with no-cache and CSP, hashed assets with immutable cache, and JSON 404 for /api/*', async () => {
    const app = Fastify();
    const registered = registerStaticSpa(app, tempDir);
    expect(registered).toBe(true);

    const indexRes = await app.inject({ method: 'GET', url: '/' });
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.headers['content-type']).toContain('text/html');
    expect(indexRes.headers['cache-control']).toBe('no-cache');
    expect(indexRes.headers['content-security-policy']).toBe(CSP_HEADER);
    expect(indexRes.headers['x-content-type-options']).toBe('nosniff');
    expect(indexRes.body).toContain('SQL Scratchpad');

    const assetRes = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers['content-type']).toContain('application/javascript');
    expect(assetRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(assetRes.headers['content-security-policy']).toBe(CSP_HEADER);

    const missingAsset = await app.inject({ method: 'GET', url: '/assets/nope.js' });
    expect(missingAsset.statusCode).toBe(404);

    const apiMissing = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    expect(apiMissing.statusCode).toBe(404);
    expect(apiMissing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });

    await app.close();
  });

  it('serves favicon.svg, favicon.ico, and apple-touch-icon.png with proper Content-Type and without SPA fallback', async () => {
    const app = Fastify();
    expect(registerStaticSpa(app, tempDir)).toBe(true);

    try {
      const cases = [
        { url: '/favicon.svg', contentType: 'image/svg+xml', snippet: '<svg' },
        { url: '/favicon.ico', contentType: 'image/x-icon', snippet: null },
        { url: '/apple-touch-icon.png', contentType: 'image/png', snippet: null },
      ] as const;

      for (const { url, contentType, snippet } of cases) {
        const getRes = await app.inject({ method: 'GET', url });
        expect(getRes.statusCode, `GET ${url}`).toBe(200);
        expect(getRes.headers['content-type']).toBe(contentType);
        expect(getRes.headers['content-security-policy']).toBe(CSP_HEADER);
        expect(getRes.headers['x-content-type-options']).toBe('nosniff');
        expect(getRes.body).not.toContain('<!doctype html>');
        if (snippet) {
          expect(getRes.body).toContain(snippet);
        }

        const headRes = await app.inject({ method: 'HEAD', url });
        expect(headRes.statusCode, `HEAD ${url}`).toBe(200);
        expect(headRes.headers['content-type']).toBe(contentType);
        expect(headRes.rawPayload.length).toBe(0);
      }
    } finally {
      await app.close();
    }
  });

  it('returns false when distDir has no index.html', () => {
    const app = Fastify();
    expect(registerStaticSpa(app, join(tempDir, 'missing'))).toBe(false);
  });

  it('F5: refuses dotfiles and path traversal with 404 independent of nginx', async () => {
    const app = Fastify();
    expect(registerStaticSpa(app, tempDir)).toBe(true);

    try {
      const blockedPaths = [
        '/.env',
        '/%2eenv',
        '/.git/config',
        '/assets/.hidden',
        '/assets/../.env',
        '/..%2f..%2fetc/passwd',
        '/assets/..%2f..%2fetc/passwd',
        '/assets/..%5c.env',
      ];

      for (const url of blockedPaths) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, `expected 404 for ${url}`).toBe(404);
        expect(res.body).not.toContain('shouldnotserve');
        expect(res.body).not.toContain('TOPSECRET');
        expect(res.body).not.toContain('repositoryformatversion');
      }

      // Normal files still serve 200
      const okIndex = await app.inject({ method: 'GET', url: '/' });
      expect(okIndex.statusCode).toBe(200);
      const okAsset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
      expect(okAsset.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
