import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { DatasetMeta } from '@sql-scratchpad/shared';

const DatasetSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  title: z.string().min(1),
  description: z.string().min(1),
  tables: z.array(z.string()),
  engines: z.array(z.enum(['mariadb', 'sqlite'])).min(1),
});

const DatasetListSchema = z.array(DatasetSchema).min(1);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASETS_PATH = resolve(__dirname, '..', 'datasets.json');

export function loadDatasets(filePath: string = DEFAULT_DATASETS_PATH): DatasetMeta[] {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = DatasetListSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid datasets.json: ${parsed.error.message}`);
  }
  return parsed.data;
}
