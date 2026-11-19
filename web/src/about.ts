export const SOURCE_URL = 'https://github.com/hexawulf/sqlyard';

export const ABOUT_INFO = {
  tagline: 'SQLyard — a Letos-style SQL playground (MariaDB + SQLite)',
  version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0',
  gitSha: typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__ : 'dev',
  developerName: 'Erling Wulf Weinreich (0xWulf)',
  developerEmail: 'dev@0xwulf.dev',
  sourceUrl: SOURCE_URL,
  builtWith: 'MariaDB, sql.js (SQLite), Vue 3, CodeMirror 6, Fastify',
  privacy:
    'No accounts, no analytics, and no SQL logged. Workspaces are temporary and deleted after 2 h idle; editor tabs and history stay in your browser.',
  disclaimer: 'Not affiliated with any university.',
} as const;
