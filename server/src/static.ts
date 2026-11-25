import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { formatApiError } from './errors.js';

export const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'";

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.sql': 'application/sql; charset=utf-8',
};

function applySecurityHeaders(reply: FastifyReply): void {
  void reply.header('Content-Security-Policy', CSP_HEADER);
  void reply.header('X-Content-Type-Options', 'nosniff');
  void reply.header('Referrer-Policy', 'no-referrer');
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function registerStaticSpa(app: FastifyInstance, distDir: string): boolean {
  const indexHtmlPath = resolve(distDir, 'index.html');
  if (!existsSync(indexHtmlPath)) {
    return false;
  }

  const normalizedRoot = resolve(distDir);
  const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;

  app.setNotFoundHandler(async (req, reply) => {
    const rawPath = req.url.split('?')[0] ?? '/';

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return reply.code(400).send(formatApiError('BAD_REQUEST', 'Malformed URL path'));
    }

    if (
      rawPath.startsWith('/api/') ||
      rawPath === '/api' ||
      decodedPath.startsWith('/api/') ||
      decodedPath === '/api'
    ) {
      return reply.code(404).send(formatApiError('NOT_FOUND', 'Route not found'));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(404).send(formatApiError('NOT_FOUND', 'Route not found'));
    }

    // Refuse null bytes, backslashes, dotfiles/dot-directories, and traversal segments (404)
    if (decodedPath.includes('\0') || decodedPath.includes('\\') || rawPath.includes('\\')) {
      return reply.code(404).send(formatApiError('NOT_FOUND', 'Not found'));
    }
    const hasBlockedSegment = (p: string): boolean =>
      p.split('/').some((seg) => seg === '.' || seg === '..' || seg.startsWith('.'));
    if (hasBlockedSegment(rawPath) || hasBlockedSegment(decodedPath)) {
      return reply.code(404).send(formatApiError('NOT_FOUND', 'Not found'));
    }

    const relativePath = decodedPath.replace(/^\/+/, '');
    const candidate =
      relativePath.length > 0 ? resolve(normalizedRoot, relativePath) : indexHtmlPath;

    if (candidate !== indexHtmlPath && !candidate.startsWith(rootPrefix)) {
      return reply.code(404).send(formatApiError('NOT_FOUND', 'Not found'));
    }

    applySecurityHeaders(reply);

    if (candidate !== indexHtmlPath && isRegularFile(candidate)) {
      const ext = extname(candidate).toLowerCase();
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      const isHashedAsset = decodedPath.startsWith('/assets/');
      void reply.header(
        'Cache-Control',
        isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      void reply.type(mime);
      const buf = await readFile(candidate);
      return reply.code(200).send(req.method === 'HEAD' ? undefined : buf);
    }

    // If the request explicitly asked for a missing asset file, return 404 instead of index.html
    if (decodedPath.startsWith('/assets/')) {
      return reply.code(404).send(formatApiError('NOT_FOUND', 'Asset not found'));
    }

    void reply.header('Cache-Control', 'no-cache');
    void reply.type('text/html; charset=utf-8');
    const html = await readFile(indexHtmlPath);
    return reply.code(200).send(req.method === 'HEAD' ? undefined : html);
  });

  return true;
}
