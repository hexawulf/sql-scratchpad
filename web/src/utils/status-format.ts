import type { StatementResult } from '@sql-scratchpad/shared';
import { ApiHttpError } from '../engines/mariadb';
import type { StatusLogEntry } from '../types/state';

export function formatTimeHHMMSS(date: Date = new Date()): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function formatDurationSeconds(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  return seconds.toFixed(5);
}

export function formatStatementStatusLines(
  result: StatementResult,
  date: Date = new Date(),
): Omit<StatusLogEntry, 'id'>[] {
  const ts = formatTimeHHMMSS(date);
  const lines: Omit<StatusLogEntry, 'id'>[] = [];

  if (result.kind === 'error') {
    const err = result.error;
    const errnoPart = err?.errno !== undefined ? ` ${err.errno}` : '';
    const statePart = err?.sqlState ? ` (${err.sqlState})` : '';
    const msg = err?.message ?? 'Unknown SQL error';
    lines.push({
      timestamp: ts,
      level: 'error',
      message: `[${ts}] ERROR${errnoPart}${statePart}: ${msg}`,
    });
  } else {
    const sec = formatDurationSeconds(result.durationMs);
    const count =
      result.kind === 'rows'
        ? (result.rowCount ?? result.rows?.length ?? 0)
        : (result.affectedRows ?? 0);
    const truncNote = result.truncated ? ` (truncated at ${count})` : '';
    lines.push({
      timestamp: ts,
      level: 'info',
      message: `[${ts}] Query finished in ${sec} second(s). Rows affected: ${count}${truncNote}`,
    });
  }

  if (result.warnings && result.warnings.length > 0) {
    for (const w of result.warnings) {
      lines.push({
        timestamp: ts,
        level: 'warning',
        message: `[${ts}] ${w.level} ${w.code}: ${w.message}`,
      });
    }
  }

  return lines;
}

export function formatNoticeLine(
  text: string,
  level: StatusLogEntry['level'] = 'notice',
  date: Date = new Date(),
): Omit<StatusLogEntry, 'id'> {
  const ts = formatTimeHHMMSS(date);
  return {
    timestamp: ts,
    level,
    message: `[${ts}] ${text}`,
  };
}

export function formatRetryAfterMinutes(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return minutes === 1 ? 'try again in 1 minute' : `try again in ${minutes} minutes`;
}

export function formatApiErrorForUser(err: unknown): {
  message: string;
  isRateLimitOrCapacity: boolean;
} {
  if (err instanceof ApiHttpError && (err.status === 429 || err.status === 503)) {
    const base = err.message.trim() || `Request failed with status ${err.status}`;
    if (err.retryAfterSec !== undefined && err.retryAfterSec > 0) {
      const retryPhrase = formatRetryAfterMinutes(err.retryAfterSec);
      const separator = /[.!?]$/.test(base) ? ' ' : '. ';
      return {
        message: `${base}${separator}Please ${retryPhrase}.`,
        isRateLimitOrCapacity: true,
      };
    }
    return {
      message: base,
      isRateLimitOrCapacity: true,
    };
  }
  const message = err instanceof Error && err.message ? err.message : 'Unexpected error';
  return {
    message,
    isRateLimitOrCapacity: false,
  };
}
