import type { StatementResult } from '@sql-scratchpad/shared';

interface ExtractedStatement {
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
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\uFEFF') {
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
    if (ch === '/' && sql[i + 1] === '*' && sql[i + 2] !== '!' && !(sql[i + 2] === 'M' && sql[i + 3] === '!')) {
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

function stripAllCommentsAndLiterals(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;
    const next = i + 1 < n ? sql[i + 1] : '';

    if (ch === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]!))) {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '#') {
      i += 1;
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      if (i + 2 < n && sql[i + 2] === '!') {
        i += 3;
        while (i < n && /[0-9]/.test(sql[i]!)) i += 1;
        out += ' ';
        continue;
      }
      i += 2;
      while (i < n && !(sql[i] === '*' && i + 1 < n && sql[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === '*' && next === '/') {
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function splitScriptWithDelimiters(rawSql: string): string[] {
  const sql = rawSql.charCodeAt(0) === 0xfeff ? rawSql.slice(1) : rawSql;
  const statements: string[] = [];
  const n = sql.length;
  let delimiter = ';';
  let chunkStart = 0;
  let i = 0;
  let atLineStart = true;
  let quote: "'" | '"' | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  const pushChunk = (endOffset: number) => {
    const raw = sql.slice(chunkStart, endOffset);
    const { text } = stripLeadingCommentsAndWhitespace(raw);
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      statements.push(trimmed);
    }
  };

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        atLineStart = true;
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === '\n') atLineStart = true;
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

    if (atLineStart) {
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        i += 1;
        continue;
      }
      if (ch === '\n') {
        i += 1;
        continue;
      }
      const delimMatch = /^DELIMITER[ \t]+([^\r\n]+)/i.exec(sql.slice(i));
      if (delimMatch) {
        pushChunk(i);
        const nextDelim = delimMatch[1]!.trim();
        if (nextDelim) delimiter = nextDelim;
        i += delimMatch[0].length;
        if (sql[i] === '\r') i += 1;
        if (sql[i] === '\n') i += 1;
        chunkStart = i;
        atLineStart = true;
        continue;
      }
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
      atLineStart = false;
      i += 1;
      continue;
    }
    if (delimiter.length > 0 && sql.startsWith(delimiter, i)) {
      pushChunk(i);
      i += delimiter.length;
      chunkStart = i;
      atLineStart = false;
      continue;
    }
    if (ch === '\n') {
      atLineStart = true;
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
      atLineStart = false;
    }
    i += 1;
  }

  if (chunkStart < n) {
    pushChunk(n);
  }
  return statements;
}

function stripTrailingSemicolonsAndWhitespace(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === ';' || /\s/.test(s[end - 1]!))) {
    end -= 1;
  }
  return s.slice(0, end);
}

function extractSingleConditionalCommentBody(s: string): string | null {
  const isMaria = s.startsWith('/*M!');
  if ((!isMaria && !s.startsWith('/*!')) || !s.endsWith('*/')) {
    return null;
  }
  let i = isMaria ? 4 : 3;
  const bodyEnd = s.length - 2;
  while (i < bodyEnd && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) {
    i += 1;
  }
  const wsStart = i;
  while (i < bodyEnd && /\s/.test(s[i]!)) {
    i += 1;
  }
  if (i === wsStart || i >= bodyEnd) return null;
  const body = s.slice(i, bodyEnd);
  if (body.includes('*/')) return null;
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSkippableDumpHeader(stmt: string): boolean {
  const lead = stripTrailingSemicolonsAndWhitespace(stripLeadingCommentsAndWhitespace(stmt).text);
  const inner = extractSingleConditionalCommentBody(lead);
  if (inner !== null) {
    if (/^SET\b/i.test(inner)) return true;
    if (/^ALTER\s+TABLE\s/i.test(inner) && /\b(?:DISABLE|ENABLE)\s+KEYS\b/i.test(inner)) {
      return true;
    }
  }
  const cleaned = stripAllCommentsAndLiterals(stmt).trim();
  if (/^USE\b/i.test(cleaned)) return true;
  if (/^(?:LOCK|UNLOCK)\s+TABLES?\b/i.test(cleaned)) return true;
  return false;
}

const READ_ONLY_START_RE = /^(?:SELECT|SHOW|EXPLAIN|DESCRIBE|DESC|TABLE|VALUES|HELP)\b/i;

function isWithSelectStatement(cleaned: string): boolean {
  let i = 4; // skip 'WITH'
  const n = cleaned.length;
  let sawCteBody = false;

  while (i < n) {
    while (i < n && /\s/.test(cleaned[i]!)) i += 1;
    // Skip CTE name / RECURSIVE / column list / AS until the CTE body '('
    const openParen = cleaned.indexOf('(', i);
    if (openParen === -1) return false;

    // Check if there is an AS before '(' or column list '(col1, col2) AS (...)'
    let depth = 1;
    let j = openParen + 1;
    while (j < n && depth > 0) {
      if (cleaned[j] === '(') depth += 1;
      else if (cleaned[j] === ')') depth -= 1;
      j += 1;
    }
    if (depth !== 0) return false;

    // If immediately followed by 'AS', this '(...)' was a CTE column list; keep scanning
    const afterParen = cleaned.slice(j).trimStart();
    if (/^AS\b/i.test(afterParen)) {
      i = j;
      continue;
    }

    sawCteBody = true;
    if (afterParen.startsWith(',')) {
      const commaIdx = cleaned.indexOf(',', j);
      i = commaIdx + 1;
      continue;
    }

    // Main statement following the final CTE
    const main = afterParen.replace(/^\(+\s*/, '');
    return /^(?:SELECT|TABLE|VALUES)\b/i.test(main);
  }

  return sawCteBody && false;
}

function isReadOnlyStatement(stmt: string): boolean {
  const cleaned = stripAllCommentsAndLiterals(stmt).trim();
  if (!cleaned) return true;

  // Unwrap leading parentheses for e.g. `(SELECT 1) UNION (SELECT 2)`
  const unwrapped = cleaned.replace(/^\(+\s*/, '');
  if (READ_ONLY_START_RE.test(unwrapped)) {
    return true;
  }
  if (/^WITH\b/i.test(unwrapped)) {
    return isWithSelectStatement(unwrapped);
  }
  return false;
}

interface SqlScriptClassification {
  statementCount: number;
  isQueryOnly: boolean;
  isEmpty: boolean;
}

/**
 * Classifies a `.sql` script for the Import dialog: returns `isQueryOnly: true`
 * when the script contains no DDL/DML statements (only read-only queries such as
 * SELECT / WITH...SELECT / SHOW / EXPLAIN / DESCRIBE, dump headers, or comments).
 */
export function classifySqlScriptForImport(sql: string): SqlScriptClassification {
  const statements = splitScriptWithDelimiters(sql);
  let statementCount = 0;
  let hasMutating = false;

  for (const stmt of statements) {
    if (!stripAllCommentsAndLiterals(stmt).trim()) continue;
    if (isSkippableDumpHeader(stmt)) continue;

    statementCount += 1;
    if (!isReadOnlyStatement(stmt)) {
      hasMutating = true;
      break;
    }
  }

  return {
    statementCount,
    isQueryOnly: !hasMutating,
    isEmpty: statementCount === 0,
  };
}

export function isQueryOnlyScript(sql: string): boolean {
  return classifySqlScriptForImport(sql).isQueryOnly;
}
