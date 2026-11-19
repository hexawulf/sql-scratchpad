import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSP_HEADER, registerStaticSpa } from './static.js';

describe('registerStaticSpa', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sqlyard-static-'));
    mkdirSync(join(tempDir, 'assets'), { recursive: true });
    writeFileSync(join(tempDir, 'index.html'), '<!doctype html><html><body>SQLyard</body></html>');
    writeFileSync(join(tempDir, 'assets', 'app-abc123.js'), 'console.log("ok");');
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
    expect(indexRes.body).toContain('SQLyard');

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

  it('returns false when distDir has no index.html', () => {
    const app = Fastify();
    expect(registerStaticSpa(app, join(tempDir, 'missing'))).toBe(false);
  });
});
