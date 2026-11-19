import type { StatementResult } from '@sql-scratchpad/shared';

export interface ExtractedStatement {
  sql: string;
  startLine: number;
  from: number;
  to: number;
}

function countLinesUpTo(text: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function stripLeadingCommentsAndWhitespace(sql: string): { text: string; leadingChars: number } {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]!))) {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '#') {
      const nl = sql.indexOf('\n', i + 1);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    break;
  }
  return { text: sql.slice(i), leadingChars: i };
}

/**
 * Splits a SQL script into top-level semicolon-delimited chunks with source offsets,
 * respecting single/double/backtick quotes and SQL comments.
 */
export function splitStatementsWithOffsets(sql: string): ExtractedStatement[] {
  const chunks: ExtractedStatement[] = [];
  const n = sql.length;
  let chunkStart = 0;
  let i = 0;
  let quote: "'" | '"' | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  const pushChunk = (endOffset: number) => {
    const raw = sql.slice(chunkStart, endOffset);
    const { text, leadingChars } = stripLeadingCommentsAndWhitespace(raw);
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      const effectiveStart = chunkStart + leadingChars;
      chunks.push({
        sql: trimmed,
        startLine: countLinesUpTo(sql, effectiveStart),
        from: chunkStart,
        to: endOffset,
      });
    }
  };

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === '\\' && quote !== '`') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]!))) {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '#') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === ';') {
      pushChunk(i + 1);
      chunkStart = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }

  if (chunkStart < n) {
    pushChunk(n);
  }

  return chunks;
}

export function extractStatementAtCursor(sql: string, offset: number): ExtractedStatement | null {
  const statements = splitStatementsWithOffsets(sql);
  if (statements.length === 0) return null;

  for (const stmt of statements) {
    if (offset >= stmt.from && offset <= stmt.to) {
      return stmt;
    }
  }

  // If cursor is in trailing whitespace after the last statement, run the last statement.
  const last = statements[statements.length - 1]!;
  if (offset > last.to) {
    return last;
  }
  return statements[0] ?? null;
}

const DDL_PREFIX_RE = /^(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i;

export function containsDdlStatement(results: StatementResult[]): boolean {
  return results.some((res) => {
    if (res.kind === 'error') return false;
    const { text } = stripLeadingCommentsAndWhitespace(res.sql);
    return DDL_PREFIX_RE.test(text);
  });
}
