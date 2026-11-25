import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse } from '@sql-scratchpad/shared';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryAfterSec?: number;

  constructor(statusCode: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export function formatApiError(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

export function fastifyErrorHandler(
  err: FastifyError | ApiError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof ApiError) {
    if (err.statusCode === 403) {
      req.log.warn({ event: 'authz.forbidden', code: err.code }, 'Forbidden request');
    } else if (err.statusCode === 429) {
      req.log.warn(
        { event: 'rate_limited', code: err.code, retryAfterSec: err.retryAfterSec },
        'Client rate or quota limit exceeded',
      );
    }
    if (err.retryAfterSec !== undefined) {
      void reply.header('Retry-After', String(err.retryAfterSec));
    }
    void reply.code(err.statusCode).send(formatApiError(err.code, err.message));
    return;
  }

  const fastifyErr = err as FastifyError;
  if (fastifyErr.validation) {
    void reply
      .code(400)
      .send(formatApiError('VALIDATION_ERROR', fastifyErr.message || 'Invalid request'));
    return;
  }

  if (fastifyErr.statusCode === 413 || fastifyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    const isImport = req.url.includes('/import');
    void reply
      .code(413)
      .send(
        formatApiError(
          'PAYLOAD_TOO_LARGE',
          isImport ? 'Request body exceeds 6 MB limit' : 'Request body exceeds 256 KB limit',
        ),
      );
    return;
  }

  if (fastifyErr.statusCode === 429) {
    req.log.warn({ event: 'rate_limited', code: 'RATE_LIMITED' }, 'Rate limit exceeded');
    void reply
      .code(429)
      .send(formatApiError('RATE_LIMITED', fastifyErr.message || 'Too many requests'));
    return;
  }

  if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
    void reply
      .code(fastifyErr.statusCode)
      .send(formatApiError(fastifyErr.code || 'BAD_REQUEST', fastifyErr.message));
    return;
  }

  req.log.error({ err }, 'Unhandled server error');
  void reply.code(500).send(formatApiError('INTERNAL_ERROR', 'Internal server error'));
}
