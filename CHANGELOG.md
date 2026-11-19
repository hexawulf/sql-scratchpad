# Changelog

All notable changes to SQL Scratchpad are documented in this file.

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
