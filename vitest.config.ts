import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['server/src/**/*.test.ts', 'shared/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/*.golden.test.ts', '**/node_modules/**', '**/dist/**'],
        },
      },
      'web/vitest.config.ts',
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['server/src/**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 60_000,
          hookTimeout: 30_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'golden',
          environment: 'node',
          include: ['**/*.golden.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
