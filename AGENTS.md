# SQL Scratchpad — Contributor & Agent Guide

## Architecture & Docs

- Architecture overview: `docs/ARCHITECTURE.md`
- Self-hosting & configuration: `docs/SELF-HOSTING.md`
- Security & threat model: `SECURITY.md`

## Workspace Layout

- `shared/` — Shared TypeScript types (`EngineAdapter`, `ExecRequest`/`ExecResponse`, `ImportRequest`/`ImportResponse`, `SchemaTree`, `DatasetMeta`).
- `server/` — Fastify 5 API, static SPA serving, MariaDB workspace provisioning, execution engine, SQL import engine, schema introspector, janitor.
- `web/` — Vue 3 + Vite + CodeMirror 6 frontend SPA.
- `db/` — MariaDB 11.4 Dockerfile, configuration (`db/conf.d/sql-scratchpad.cnf`), and init scripts.
- `seeds/` — Portable `sample-library.sql` dataset in plain standard SQL.
- `scripts/verify-seeds.ts` — Loads `seeds/sample-library.sql` into MariaDB and checks tables, row counts, foreign keys and the `CHECK` constraint.
- `e2e/` — Playwright end-to-end tests.

## Commands

Requires Node.js >= 24 and `pnpm@12.21.0` (`corepack enable`).

- Install: `pnpm install --frozen-lockfile`
- Build all packages: `pnpm build`
- Typecheck: `pnpm typecheck`
- Lint / Format check: `pnpm lint` / `pnpm format:check`
- Unit & web component tests: `pnpm exec vitest run --project unit --project web`
- Integration tests (requires dev MariaDB on `127.0.0.1:3307`): `pnpm test:int`
- Seed check (requires dev MariaDB): `pnpm seeds:verify`
- E2E tests (Playwright): `pnpm test:e2e`
- Repeated local E2E or screenshot runs can hit the per-IP workspace limits (20 creates/h). For a local test server only, set `LOADTEST_ALLOW_IPS=127.0.0.1` (comma-separated IPs, exempt from rate limits and the per-IP cap). Never set it in production.

## Non-Negotiable Engineering Rules

- **Primary dialect:** MariaDB 11.4 LTS. Keep `seeds/sample-library.sql` plain standard SQL (explicit integer IDs, standard SQL types, no `AUTO_INCREMENT`, no backticks, no `ENGINE`/`CHARSET`, no `CREATE DATABASE`/`USE`).
- **Dataset cloning:** Never use `CREATE TABLE ... LIKE` to clone template tables — MariaDB/MySQL drops foreign key constraints with `LIKE`. Always clone via `SHOW CREATE TABLE` + `INSERT ... SELECT`.
- **Workspace isolation:** Never weaken workspace privileges, statement timeouts, body limits, or rate limits to make a feature work. Both `/exec` and `/import` must execute strictly as the workspace's own unprivileged MariaDB user (`ws_<hex>`), never `scratchpad_admin`.
- **Privacy & logging:** Never log raw SQL text, imported file contents, or passwords. Log only byte lengths and truncated hashes (`sqlLogMeta`).
- **Frontend security:** Never use `v-html` for query output or user strings. Keep all fonts and runtime dependencies bundled (no external CDN requests).
- **Dependencies:** Keep root `package.json` for dev tooling only; runtime dependencies belong in the owning package (`server/` or `web/`).
