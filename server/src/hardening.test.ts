import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IpHasher,
  buildApp,
  checkDenylist,
  loadConfig,
  normalizeClientIp,
  parseIpAllowList,
  parseTrustProxy,
} from './index.js';

function makeMockPool(healthy = true): Pool {
  return {
    query: async () => {
      if (!healthy) throw new Error('db down');
      return [[{ 1: 1 }], []];
    },
    end: async () => {},
  } as unknown as Pool;
}

const BASE_ENV = {
  SQLSCRATCHPAD_ADMIN_PASSWORD: 'unit-test-password',
  LOG_LEVEL: 'silent',
};

describe('M8-lite hardening unit checks', () => {
  let staticDir: string;

  beforeAll(() => {
    staticDir = mkdtempSync(join(tmpdir(), 'sql-scratchpad-maint-'));
    writeFileSync(
      join(staticDir, 'index.html'),
      '<!doctype html><html><head><title>SQL Scratchpad</title></head><body>OK</body></html>',
    );
  });

  afterAll(() => {
    rmSync(staticDir, { recursive: true, force: true });
  });

  it('defaults TTLs, session idle cap, janitor interval, and per-IP workspace cap for public use', () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.WORKSPACE_TTL_MS).toBe(2 * 60 * 60 * 1000);
    expect(cfg.WORKSPACE_MAX_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(cfg.SESSION_IDLE_TTL_MS).toBe(10 * 60 * 1000);
    expect(cfg.JANITOR_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(cfg.MAX_WORKSPACES).toBe(50);
    expect(cfg.MAX_WORKSPACES_PER_IP).toBe(6);
    expect(loadConfig({ ...BASE_ENV, MAX_WORKSPACES_PER_IP: '4' }).MAX_WORKSPACES_PER_IP).toBe(4);
    expect(cfg.MAINTENANCE).toBe(false);
  });

  it('parses TRUST_PROXY strictly as IP/CIDR list and rejects boolean/named/invalid values', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('   ')).toBe(false);
    expect(parseTrustProxy('192.0.2.10')).toEqual(['192.0.2.10']);
    expect(parseTrustProxy('192.0.2.10, 198.51.100.0/24, ::1')).toEqual([
      '192.0.2.10',
      '198.51.100.0/24',
      '::1',
    ]);

    expect(() => parseTrustProxy('true')).toThrow();
    expect(() => parseTrustProxy('1')).toThrow();
    expect(() => parseTrustProxy('loopback')).toThrow();
    expect(() => parseTrustProxy('192.0.2.10/33')).toThrow();
    expect(() => loadConfig({ ...BASE_ENV, TRUST_PROXY: 'true' })).toThrow();
  });

  it('validates LOADTEST_ALLOW_IPS as exact IPs only', () => {
    expect(parseIpAllowList(undefined).size).toBe(0);
    expect(parseIpAllowList('192.0.2.1, 198.51.100.2')).toEqual(
      new Set(['192.0.2.1', '198.51.100.2']),
    );
    expect(() => parseIpAllowList('192.0.2.0/24')).toThrow();
    expect(() => parseIpAllowList('not-an-ip')).toThrow();
  });

  it('hashes client IPs with a per-process random salt that rotates daily in memory', () => {
    const day1 = new Date('2026-11-19T12:00:00Z');
    const day1Later = new Date('2026-11-19T23:59:59Z');
    const day2 = new Date('2026-11-20T00:00:01Z');

    const hasherA = new IpHasher(day1);
    const hasherB = new IpHasher(day1);

    const h1 = hasherA.hash('203.0.113.42', day1);
    const h1Again = hasherA.hash('203.0.113.42', day1Later);
    const hOtherInstance = hasherB.hash('203.0.113.42', day1);
    const hNextDay = hasherA.hash('203.0.113.42', day2);

    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).toBe(h1Again);
    expect(h1).not.toBe(hOtherInstance);
    expect(h1).not.toBe(hNextDay);
    expect(h1).not.toContain('203.0.113.42');
  });

  it('never logs raw client IP addresses in Fastify request logs', async () => {
    const chunks: string[] = [];
    const logStream = new PassThrough();
    logStream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const config = loadConfig({ ...BASE_ENV, LOG_LEVEL: 'info', TRUST_PROXY: '' });
    const ctx = await buildApp({
      config,
      adminPool: makeMockPool(true),
      enableRateLimit: false,
      staticDir,
      logStream,
    });

    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/health',
        remoteAddress: '203.0.113.77',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }

    const rawLogs = chunks.join('');
    expect(rawLogs.length).toBeGreaterThan(0);
    expect(rawLogs).not.toContain('203.0.113.77');
    expect(rawLogs).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(rawLogs).toContain('"clientIpHash"');
  });

  it('ignores spoofed X-Forwarded-For when TRUST_PROXY is empty and respects it only from trusted proxy', async () => {
    // 1. TRUST_PROXY empty: spoofed X-Forwarded-For must NOT change request.ip or rate-limit bucket
    const noTrustCfg = loadConfig({ ...BASE_ENV, TRUST_PROXY: '' });
    const noTrustCtx = await buildApp({
      config: noTrustCfg,
      adminPool: makeMockPool(true),
      enableRateLimit: true,
      staticDir,
    });

    try {
      // /api/workspaces has max 20/h rate limit; trigger validation error 400 after rate-limit check
      let got429 = false;
      for (let i = 0; i < 22; i += 1) {
        const res = await noTrustCtx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '203.0.113.10',
          headers: {
            'x-forwarded-for': `198.51.100.${i + 1}`,
          },
          payload: { dataset: 'nonexistent-dataset' },
        });
        if (res.statusCode === 429) {
          got429 = true;
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
          break;
        }
      }
      expect(got429).toBe(true);
    } finally {
      await noTrustCtx.app.close();
    }

    // 2. TRUST_PROXY set to 203.0.113.1: spoofed header from untrusted IP 203.0.113.99 is still ignored
    const trustCfg = loadConfig({ ...BASE_ENV, TRUST_PROXY: '203.0.113.1' });
    const trustCtx = await buildApp({
      config: trustCfg,
      adminPool: makeMockPool(true),
      enableRateLimit: true,
      staticDir,
    });

    try {
      // From trusted proxy with distinct client IPs -> each client gets its own bucket (22 requests all 400, no 429)
      for (let i = 0; i < 22; i += 1) {
        const res = await trustCtx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '203.0.113.1',
          headers: {
            'x-forwarded-for': `198.51.100.${i + 1}`,
          },
          payload: { dataset: 'nonexistent-dataset' },
        });
        expect(res.statusCode).toBe(400);
      }

      // From untrusted source spoofing X-Forwarded-For -> ignored, hits 429 on 21st request
      let untrustedHit429 = false;
      for (let i = 0; i < 22; i += 1) {
        const res = await trustCtx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '203.0.113.99',
          headers: {
            'x-forwarded-for': `192.0.2.${i + 1}`,
          },
          payload: { dataset: 'nonexistent-dataset' },
        });
        if (res.statusCode === 429) {
          untrustedHit429 = true;
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
          break;
        }
      }
      expect(untrustedHit429).toBe(true);
    } finally {
      await trustCtx.app.close();
    }
  });

  it('blocks SET PASSWORD and CREATE FUNCTION ... SONAME in pre-flight denylist', () => {
    expect(checkDenylist("SET PASSWORD = PASSWORD('evil')", 'ws_abc')).toContain('SET PASSWORD');
    expect(
      checkDenylist("CREATE FUNCTION evil RETURNS INTEGER SONAME 'evil.so'", 'ws_abc'),
    ).toContain('SONAME');
    expect(
      checkDenylist("CREATE AGGREGATE FUNCTION evil RETURNS STRING SONAME 'evil.so'", 'ws_abc'),
    ).toContain('SONAME');
    // Normal stored SQL function without SONAME remains allowed
    expect(
      checkDenylist(
        'CREATE FUNCTION add_one(x INT) RETURNS INT DETERMINISTIC RETURN x + 1',
        'ws_abc',
      ),
    ).toBeNull();
  });

  it('enforces MAINTENANCE=1 kill switch: /api/* returns 503, /api/health reports maintenance, static UI still loads', async () => {
    const config = loadConfig({ ...BASE_ENV, MAINTENANCE: '1' });
    const ctx = await buildApp({
      config,
      adminPool: makeMockPool(true),
      enableRateLimit: false,
      staticDir,
    });

    try {
      const healthRes = await ctx.app.inject({ method: 'GET', url: '/api/health' });
      expect(healthRes.statusCode).toBe(200);
      expect(JSON.parse(healthRes.body)).toMatchObject({
        status: 'maintenance',
        db: 'ok',
      });

      for (const req of [
        { method: 'GET' as const, url: '/api/datasets' },
        { method: 'GET' as const, url: '/%61pi/datasets' },
        { method: 'POST' as const, url: '/api/workspaces', payload: { dataset: 'empty' } },
        { method: 'POST' as const, url: '/%61pi/workspaces', payload: { dataset: 'empty' } },
        {
          method: 'POST' as const,
          url: '/api/workspaces/abcdefghijkl/exec',
          payload: { sql: 'SELECT 1;' },
        },
        { method: 'GET' as const, url: '/api/workspaces/abcdefghijkl/schema' },
      ]) {
        const res = await ctx.app.inject(req);
        expect(res.statusCode).toBe(503);
        const body = JSON.parse(res.body) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('MAINTENANCE');
        expect(body.error.message.toLowerCase()).toContain('maintenance');
      }

      const uiRes = await ctx.app.inject({ method: 'GET', url: '/' });
      expect(uiRes.statusCode).toBe(200);
      expect(uiRes.headers['content-type']).toContain('text/html');
      expect(uiRes.body).toContain('SQL Scratchpad');
    } finally {
      await ctx.app.close();
    }
  });

  it('F1: defaults IPV6_PREFIX_BITS to 64 and shares rate-limit buckets across same /64 and IPv4-mapped IPv6', async () => {
    const cfg = loadConfig({ ...BASE_ENV, TRUST_PROXY: '10.0.0.1' });
    expect(cfg.IPV6_PREFIX_BITS).toBe(64);
    expect(loadConfig({ ...BASE_ENV, IPV6_PREFIX_BITS: '48' }).IPV6_PREFIX_BITS).toBe(48);
    expect(() => loadConfig({ ...BASE_ENV, IPV6_PREFIX_BITS: '0' })).toThrow();
    expect(() => loadConfig({ ...BASE_ENV, IPV6_PREFIX_BITS: '129' })).toThrow();

    // Direct IP normalisation unit checks
    expect(normalizeClientIp('203.0.113.20')).toBe('203.0.113.20');
    expect(normalizeClientIp('::ffff:203.0.113.20')).toBe('203.0.113.20');
    expect(normalizeClientIp('::FFFF:203.0.113.20')).toBe('203.0.113.20');
    expect(normalizeClientIp('0:0:0:0:0:ffff:cb00:7114')).toBe('203.0.113.20');
    expect(normalizeClientIp('2001:db8:abcd:1234::1', 64)).toBe(
      normalizeClientIp('2001:0db8:abcd:1234:ffff:ffff:ffff:ffff', 64),
    );
    expect(normalizeClientIp('2001:db8:abcd:1234::1', 64)).not.toBe(
      normalizeClientIp('2001:db8:abcd:5678::1', 64),
    );
    expect(normalizeClientIp('2001:db8:abcd:1234::1', 48)).toBe(
      normalizeClientIp('2001:db8:abcd:5678::1', 48),
    );

    // Separate process-lifetime key salt vs daily-rotated log salt (F3)
    const d1 = new Date('2026-11-19T23:59:00Z');
    const d2 = new Date('2026-11-20T00:01:00Z');
    const hasher = new IpHasher(d1, 64);
    const k1 = hasher.key('2001:db8:abcd:1234::1');
    const k2 = hasher.key('2001:db8:abcd:1234::ffff');
    const log1 = hasher.hash('2001:db8:abcd:1234::1', d1);
    const log2 = hasher.hash('2001:db8:abcd:1234::1', d2);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(log1);
    expect(log2).not.toBe(log1);
    expect(hasher.key('2001:db8:abcd:1234::1')).toBe(k1);
    expect(hasher.key('::ffff:203.0.113.20')).toBe(hasher.key('203.0.113.20'));

    const ctx = await buildApp({
      config: cfg,
      adminPool: makeMockPool(true),
      enableRateLimit: true,
      staticDir,
    });

    try {
      // 20 creates/h limit: 12 from ::1 + 8 from ::2..::9 in the SAME /64 exhausts the 20/h bucket
      for (let i = 0; i < 12; i += 1) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': '2001:db8:abcd:1234::1' },
          payload: { dataset: 'nonexistent-dataset' },
        });
        expect(res.statusCode).toBe(400);
      }
      for (let i = 0; i < 8; i += 1) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': `2001:db8:abcd:1234::${(i + 2).toString(16)}` },
          payload: { dataset: 'nonexistent-dataset' },
        });
        expect(res.statusCode).toBe(400);
      }
      // 21st request from another host in the SAME /64 must be rate-limited (429 + Retry-After)
      const samePrefixBlocked = await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '2001:db8:abcd:1234::ffff' },
        payload: { dataset: 'nonexistent-dataset' },
      });
      expect(samePrefixBlocked.statusCode).toBe(429);
      expect(Number(samePrefixBlocked.headers['retry-after'])).toBeGreaterThan(0);

      // Different /64 must NOT be blocked
      const diffPrefix = await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '2001:db8:abcd:5678::1' },
        payload: { dataset: 'nonexistent-dataset' },
      });
      expect(diffPrefix.statusCode).toBe(400);

      // Plain IPv4 and IPv4-mapped IPv6 (::ffff:a.b.c.d) must share the exact same key
      for (let i = 0; i < 12; i += 1) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': '203.0.113.20' },
          payload: { dataset: 'nonexistent-dataset' },
        });
        expect(res.statusCode).toBe(400);
      }
      for (let i = 0; i < 8; i += 1) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/workspaces',
          remoteAddress: '10.0.0.1',
          headers: { 'x-forwarded-for': '::ffff:203.0.113.20' },
          payload: { dataset: 'nonexistent-dataset' },
        });
        expect(res.statusCode).toBe(400);
      }
      const mappedBlocked = await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces',
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '::ffff:203.0.113.20' },
        payload: { dataset: 'nonexistent-dataset' },
      });
      expect(mappedBlocked.statusCode).toBe(429);
      expect(Number(mappedBlocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await ctx.app.close();
    }
  });

  it('F7: defaults IMPORT_TIMEOUT_MS to 75 s and allows override via env', () => {
    expect(loadConfig(BASE_ENV).IMPORT_TIMEOUT_MS).toBe(75 * 1000);
    expect(loadConfig({ ...BASE_ENV, IMPORT_TIMEOUT_MS: '60000' }).IMPORT_TIMEOUT_MS).toBe(60_000);
  });

  it('rejects /import early for nonexistent wsId and enforces in-flight concurrency caps [API-004]', async () => {
    const cfg = loadConfig(BASE_ENV);
    const ctx = await buildApp({
      config: cfg,
      adminPool: makeMockPool(true),
      enableRateLimit: false,
      staticDir,
    });

    try {
      // Nonexistent wsId fails with 404 in onRequest even with invalid/oversized Content-Length
      const missingRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/aaaaaaaaaaaa/import',
        headers: { 'content-type': 'application/json' },
        payload: { sql: 'SELECT 1;' },
      });
      expect(missingRes.statusCode).toBe(404);
      expect(JSON.parse(missingRes.body)).toMatchObject({
        error: { code: 'WORKSPACE_NOT_FOUND' },
      });

      // Oversized Content-Length rejected with 413 before buffering
      const tooBigRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/aaaaaaaaaaaa/import',
        headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) },
        payload: '{}',
      });
      expect(tooBigRes.statusCode).toBe(413);

      // Concurrent import semaphore: inject a workspace and stall importSql
      const now = Date.now();
      (
        ctx.workspaceManager as unknown as {
          workspaces: Map<string, Record<string, unknown>>;
        }
      ).workspaces.set('bbbbbbbbbbbb', {
        wsId: 'bbbbbbbbbbbb',
        database: 'ws_bbbbbbbbbbbb',
        dbUser: 'ws_bbbbbbbbbbbb',
        password: 'pw',
        dataset: 'empty',
        createdAt: now,
        lastActiveAt: now,
        expiresAt: now + 60_000,
        absoluteExpiresAt: now + 60_000,
        sessions: {},
        sessionLocks: {},
        sessionWaiters: {},
        sessionAbort: {},
        teardownActive: false,
        deleting: false,
      });

      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      ctx.importEngine.importSql = async () => {
        await firstGate;
        return {
          ok: true,
          mode: 'append',
          totalStatements: 1,
          statementsRun: 1,
          statementsOk: 1,
          skippedCount: 0,
          skipped: [],
          rewrittenCount: 0,
          rewritten: [],
          warningsCount: 0,
          durationMs: 1,
          tablesCreated: [],
        };
      };

      const req1 = ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/bbbbbbbbbbbb/import',
        remoteAddress: '198.51.100.5',
        payload: { sql: 'SELECT 1;', mode: 'append' },
      });
      await new Promise((r) => setTimeout(r, 25));

      // Second concurrent import from same client IP hits per-IP concurrency limit (429)
      const req2 = await ctx.app.inject({
        method: 'POST',
        url: '/api/workspaces/bbbbbbbbbbbb/import',
        remoteAddress: '198.51.100.5',
        payload: { sql: 'SELECT 1;', mode: 'append' },
      });
      expect(req2.statusCode).toBe(429);
      expect(JSON.parse(req2.body)).toMatchObject({
        error: { code: 'IMPORT_CONCURRENCY_LIMIT' },
      });

      releaseFirst();
      const res1 = await req1;
      expect(res1.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });
});
