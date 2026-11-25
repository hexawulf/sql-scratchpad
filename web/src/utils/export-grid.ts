import type { ColumnMeta } from '@sql-scratchpad/shared';

const NUMERIC_TYPE_RE =
  /^(TINY|SHORT|LONG|LONGLONG|INT|INT24|TINYINT|SMALLINT|MEDIUMINT|BIGINT|DECIMAL|NEWDECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|BIT|YEAR)\b/i;

export function isNumericColumnType(type: string): boolean {
  return NUMERIC_TYPE_RE.test(type.trim());
}

export function isNumericValue(value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'bigint') return true;
  if (typeof value === 'string' && value.trim() !== '') {
    return /^-?\d+(\.\d+)?$/.test(value.trim());
  }
  return false;
}

export function formatCellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function escapeTsvCell(value: unknown): string {
  const text = formatCellText(value);
  return text.replace(/\t/g, ' ').replace(/\r\n?|\n/g, ' ');
}

export function toTsv(columns: ColumnMeta[], rows: unknown[][]): string {
  const header = columns.map((c) => escapeTsvCell(c.name)).join('\t');
  const body = rows.map((row) => columns.map((_, idx) => escapeTsvCell(row[idx])).join('\t'));
  return [header, ...body].join('\n');
}

function escapeMdCell(value: unknown): string {
  return formatCellText(value)
    .replace(/\|/g, '\\|')
    .replace(/\r\n?|\n/g, ' ');
}

export function toMarkdownTable(columns: ColumnMeta[], rows: unknown[][]): string {
  if (columns.length === 0) return '';
  const header = `| ${columns.map((c) => escapeMdCell(c.name)).join(' | ')} |`;
  const sep = `| ${columns.map((c) => (isNumericColumnType(c.type) ? '---:' : '---')).join(' | ')} |`;
  const body = rows.map(
    (row) => `| ${columns.map((_, idx) => escapeMdCell(row[idx])).join(' | ')} |`,
  );
  return [header, sep, ...body].join('\n');
}
