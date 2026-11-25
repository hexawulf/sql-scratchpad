import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '..', '.env'), quiet: true });

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildApp({
    config,
    startJanitor: true,
    cleanupOrphansOnBoot: true,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Graceful shutdown initiated');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await app.listen({
    host: config.HOST,
    port: config.PORT,
    listenTextResolver: () => `SQL Scratchpad HTTP server listening on port ${config.PORT}`,
  });
}

main().catch((err: unknown) => {
  const safeErr =
    err instanceof Error
      ? {
          name: err.name,
          code: (err as { code?: string }).code,
          message:
            'sql' in err || 'sqlMessage' in err
              ? '[REDACTED SQL ERROR]'
              : err.message
                  .replace(/(IDENTIFIED\s+BY\s+)(?:'[^']*'|"[^"]*"|\S+)/gi, '$1[REDACTED]')
                  .replace(/(PASSWORD\s*\()\s*(?:'[^']*'|"[^"]*"|[^)]*)\)/gi, '$1[REDACTED])'),
        }
      : { message: 'Fatal startup error' };
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', err: safeErr, msg: 'Startup failed' })}\n`,
  );
  process.exit(1);
});
