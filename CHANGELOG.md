# Changelog

All notable changes to SQL Scratchpad are documented in this file.

## [0.3.1] - 2026-11-20

### Security

- **IPv6 prefix & mapped-IPv4 normalisation (`IPV6_PREFIX_BITS`, default `64`):** client addresses are now normalised before hashing for rate-limit buckets, import byte budgets, and per-key workspace ownership caps — IPv4 stays as-is, IPv4-mapped IPv6 (`::ffff:a.b.c.d`) unwraps to plain IPv4, and native IPv6 collapses to its configured prefix (`/64` by default).
- **Separated log and rate-limit hashing salts:** request logs retain the daily-rotated (UTC) in-memory random salt, while rate-limit and workspace-ownership keys now use a separate process-lifetime in-memory random salt (never rotated, never logged) so UTC midnight no longer resets per-key workspace caps or rate-limit buckets.
- **Additional route rate limits:** added per-key rate limits to `POST /api/workspaces/:wsId/reset` (`10/h`), `POST /api/workspaces/:wsId/sessions/:session/kill` (`60/min`), and `DELETE /api/workspaces/:wsId` (`60/min`), all returning `429` with `Retry-After`.
- **Static SPA handler defence-in-depth:** `registerStaticSpa` now refuses dotfiles/dot-directories and path traversal segments with HTTP `404` directly in the app, independent of reverse-proxy rules.

### Fixed

- **Session-lock-aware reset, delete, and janitor:** `resetWorkspace` and `deleteWorkspace` now acquire session locks before tearing down connections (sending `KILL QUERY` and waiting up to 10 s for clean release if a statement or import is running, with zero lock leaks on error/timeout paths). The background janitor now skips busy workspaces and sessions rather than tearing them down mid-request.

### Changed

- Lowered default `IMPORT_TIMEOUT_MS` from `90 s` (`90000`) to `75 s` (`75000`, configurable via env) to leave headroom under ~100 s upstream reverse-proxy/CDN timeouts.

## [0.3.0] - 2026-11-19

### Changed

- Renamed the project from SQLyard to **SQL Scratchpad** (`sql-scratchpad`, `sql-scratchpad.com`) to avoid confusion with an unrelated existing SQL brand.
- Renamed workspace package scope (`@sql-scratchpad/*`), Docker image and Compose project names (`sql-scratchpad`, `sql-scratchpad-db`), environment variable prefix (`SQLSCRATCHPAD_*`), MariaDB admin user (`scratchpad_admin`), and browser storage key (`sql-scratchpad:v1`).
- Raised MariaDB `max_connections` from `60` to `150`; tightened default workspace TTLs to **2 h** idle (`WORKSPACE_TTL_MS`) and **12 h** absolute max (`WORKSPACE_MAX_TTL_MS`), and idle pinned-session timeout to **10 min** (`SESSION_IDLE_TTL_MS`, rolling back open transactions).
- Updated global 50-workspace cap response to HTTP `503` (`"SQL Scratchpad is busy, try again in a few minutes"`).
- Hardened `TRUST_PROXY` parsing to accept explicit IP/CIDR entries only (ignoring all forwarded headers when empty).

### Added

- Per-IP live-workspace cap (`MAX_WORKSPACES_PER_IP`, default `3`; returns `429` with `Retry-After` and hint to close a workspace or wait) and `GET /api/workspaces/:wsId/schema` rate limit (`120/min`), with `Retry-After` on all `429` responses.
- Privacy-preserving daily-salted SHA-256 IP hashing (`IpHasher`) for request logs, rate-limit buckets, and workspace ownership tracking — raw client IPs are never logged or persisted.
- Maintenance kill switch (`MAINTENANCE=1`): returns HTTP `503` on all `/api/*` routes except `/api/health` (which reports `{"status":"maintenance"}`) while keeping the static UI up with a maintenance banner.
- Pre-flight denylist rules for `SET PASSWORD`, `CREATE FUNCTION ... SONAME`, and `BENCHMARK()`, plus atomic session acquisition mutex to prevent concurrent connection races.
- Automated hostile-SQL and abuse-resistance integration suite (`server/src/hostile.int.test.ts`, `server/src/hardening.test.ts`) and public test report ([docs/SECURITY-TESTS.md](docs/SECURITY-TESTS.md)).
- Link to sister project [py-scratchpad.com](https://py-scratchpad.com) in the About dialog.

## [0.2.0] - 2026-11-19

### Added

- Initial public open-source release with MariaDB 11.4 isolated workspaces, `sample-library` and `empty` datasets, `.sql` bulk import (up to 6 MB / 60,000 statements), and a Letos-style Vue 3 + CodeMirror 6 frontend.
