# Changelog

All notable changes to SQL Scratchpad are documented in this file.

## [Unreleased]

## [0.3.9] - 2026-11-26

Hardening follow-ups to the 0.3.8 security release (#17).

### Security

- **Release pipeline:** images publish from a protected `release` environment that only `v*.*.*` tags can deploy to, and `v*` tags are protected by a ruleset. The third-party Docker Hub description action runs in its own job, away from the image push credentials. Every action must be SHA-pinned.
- **DB image:** the seed init script refuses a template that defines triggers. `scratchpad_admin` can no longer see template triggers, so clones would otherwise silently lack them. CI now uses the same grants as `db/init`.
- **Repository:** CODEOWNERS, required CI checks and code-owner review on `main`, Dependabot security updates, and private vulnerability reporting.

### Docs

- `deploy/docker-compose.yml` pins images by `tag@sha256` digest. SELF-HOSTING explains digest bumps and gives a one-time snippet that applies the 0.3.8 init hardening to an existing volume. SECURITY.md points reporters at private vulnerability reporting.

## [0.3.8] - 2026-11-26

Security release from the 2026-11-25 security swarm audit: 65 verified findings (0 critical, 5 high, 10 medium, 37 low, 13 info), 45 fixed in one atomic commit each. The full report is [docs/security/SECURITY_AUDIT_2026-11-25.md](docs/security/SECURITY_AUDIT_2026-11-25.md).

### Security

- **Query execution limits (high):** `/exec` enforces a wall-clock timeout (`EXEC_TIMEOUT_MS`) and a statement cap. Result rows stream from MariaDB and stop at `ROW_CAP` / `RESPONSE_CAP_BYTES` mid-stream, with `SESSION sql_select_limit` as a second guard. The janitor tears down workspaces past their absolute lifetime even when a session is busy.
- **ReDoS (high):** the dump-header, conditional-comment, `SONAME` and `DELIMITER` parsers scan linearly instead of using quadratic or cubic regexes. Custom delimiters are capped at 16 characters.
- **SQL denylist:** closes bypasses through backticks, `/*M!…*/` comments, dynamic SQL, `NO_BACKSLASH_ESCAPES`, advisory locks, global metadata queries and `DATA/INDEX DIRECTORY`.
- **Resource limits:** per-workspace storage cap on `/exec` and `/import` (`507 WORKSPACE_STORAGE_LIMIT`), synchronous capacity reservation before provisioning, bounded `/import` concurrency, bounded admin pool queue, single-flight `/schema`, pruned import byte budgets, and HTTP timeouts.
- **Web:** cross-site state-changing requests get `403 CROSS_SITE_FORBIDDEN` before rate limiting. A stricter CSP and security headers apply to every response, including API errors. `/api/health` and `/api/datasets` are rate-limited. TSV/Markdown/HTML exports neutralise formula prefixes and escape cells.
- **Logging:** privacy-safe audit events for denials, 403s, 429s and workspace lifecycle. Workspace ids and query strings are redacted, and mysql2 error fields are scrubbed.
- **Configuration:** the app refuses to start with a placeholder admin password or with `LOADTEST_ALLOW_IPS` in production.
- **Containers:** app code and assets are root-owned and read-only, `/tmp` is `noexec,nosuid,nodev`, and both services get `pids_limit`. The db image adds a `HEALTHCHECK`, `skip-symbolic-links` and a read-only `mysql-files-disabled`. On fresh volumes the init scripts drop remote `root@'%'`, remove `TRIGGER` on template schemas, and pass credentials through `MYSQL_PWD` and stdin.
- **Supply chain / CI:** digest-pinned Node base images that Dependabot tracks, pnpm pinned by SHA-512, `--ignore-scripts` installs, a new CI security job (`pnpm audit`, Trivy, hadolint, actionlint), job timeouts, and `release.yml` checks out the tagged SHA and verifies that it is on `main`.

### Fixed

- **Hung streaming statements:** a statement whose connection died mid-query (for example an import statement larger than `max_allowed_packet`) never finished, kept its `/import` slot and made later imports return 429. The streaming paths now fail the statement on a connection error or close.

### Added

- **Search crawler files and homepage metadata:** `web/public/robots.txt` allows crawling and points at `https://sql-scratchpad.com/sitemap.xml`. `web/public/sitemap.xml` lists `https://sql-scratchpad.com/`. The static server serves them as `text/plain` and `application/xml` instead of the SPA `index.html`. The homepage adds a canonical URL and a meta description.

## [0.3.7] - 2026-11-23

### Changed

- **0xWulf teal accent:** the accent palette and favicons move from blue to teal (`#14B8A6` dark / `#0D9488` light).
- **Toolbar layout:** the toolbar wraps on narrow screens instead of clipping. At 390 px, Format, Session and About were unreachable. The dataset picker shows only the title (`Sample: Library`). The **Transaction open** badge moves into the Query pane header, so opening a transaction no longer wraps the toolbar to a second row. **About** moves to the end of the toolbar.
- **Result grid:** numeric columns get less width and text columns more, so titles are no longer truncated next to wide id and year columns.
- **SQLite removed:** SQLite was never available, so every reference is gone. That covers the disabled engine picker, the About tagline and "Built with" (now "backed by MariaDB 11.4"), the shared `EngineId` type and `datasets.json` (`mariadb` only), and the docs. The CSP drops `script-src 'wasm-unsafe-eval'`. `pnpm seeds:verify` now checks MariaDB only, and the `sql.js` dev dependency is removed.
- **Exercises tab removed:** it was a "coming soon" placeholder with no feature behind it, so the sidebar now holds only the schema tree.
- **Schema tree:** the empty `Views (0)` branch is hidden.
- **Smaller bundle:** the SQL formatter bundles only the MariaDB dialect (JS 838 KB → 638 KB, gzip 265 KB → 208 KB). Formatting output is unchanged.

### Fixed

- **About dialog:** the dialog body was transparent because it used an undefined colour token, so the result grid showed through the text.
- **Font CSP errors:** the cyrillic-ext and vietnamese JetBrains Mono subsets were inlined as `data:` URIs, which the CSP (`default-src 'self'`) blocks. They now ship as font files.
- **Primary-button contrast:** button text now meets WCAG AA in both themes. Dark mode uses dark text on teal (5.8:1, and 9.8:1 on hover); white text was 2.5:1 and 1.5:1. Light mode fills buttons with `#0f766e` (5.5:1) instead of `#0d9488` (3.7:1).
- **Maintenance banner:** now uses the theme-aware danger colours instead of hard-coded light-mode reds.
- **Schema tree:** the PK/FK badges no longer use emoji, which showed as boxes without an emoji font. The expired-workspace notice's close button now has an accessible name.

### Removed

- The unused `autocannon`, `sql.js` and `@types/sql.js` dependencies, and the dead `web/src/index.ts`.

### CI

- CI now runs `pnpm format:check`. 17 files had drifted from Prettier style and are reformatted.

## [0.3.6] - 2026-11-22

### Changed

- **Dependency updates:** TypeScript 6.0, vitest 5.1, eslint 10, dotenv 18, @types/node 26, sql-formatter 15.9.1 (Dependabot #2–#5, #8, #9).

### Security

- **Dependabot alerts closed:** `glob` 13.0.7 → 14.0.6 and `minimatch` 10.2.6 → 11.0.9 via scoped pnpm overrides (`js-beautify>glob`, `editorconfig>minimatch` in `pnpm-workspace.yaml`); both come from the dev-only `@vue/test-utils` → `js-beautify` chain (#6). `pnpm audit`: no known vulnerabilities.

### CI

- **MariaDB stays on the 11.4 LTS line:** Dependabot ignores `mariadb` major and minor updates in `/db` (11.4 is supported until 2029); only 11.4.x patch and digest updates arrive (#7).

## [0.3.5] - 2026-11-20

### Added

- **Browser-tab and home-screen favicons:** added an original flat SVG favicon (`web/public/favicon.svg`, database cylinder with `>_` SQL prompt on the app's `#1d4ed8` accent tile for light/dark tab legibility), a 16×16 + 32×32 `favicon.ico`, a 180×180 `apple-touch-icon.png`, corresponding `<link>` and `<meta name="theme-color">` tags in `web/index.html`, and static-server route tests verifying `200` and exact `Content-Type` headers without SPA fallback.

## [0.3.4] - 2026-11-20

### Added

- **Query-only script detection in Import modal:** selecting or dropping a `.sql` file with no DDL/DML (only `SELECT`/`WITH…SELECT`/`SHOW`/`EXPLAIN`/`DESCRIBE` or comments) now shows a clear notice instead of blindly executing it, offering **Open in editor** (primary) and **Import anyway**.
- **Contextual `ER_NO_SUCH_TABLE` (1146) import hint:** failed imports hitting error 1146 now attach an optional `hint` on `ImportErrorDetail` naming the active workspace dataset, rendered in both the Messages panel and Status log, alongside an **Open in editor** button on failed import cards (≤ 256 KB).

### Fixed

- **Statement splitter comment/line attribution & UTF-8 BOM support:** `splitMariaDbStatements` now strips a leading UTF-8 BOM (fixing line-1 `DELIMITER` directives) and strips leading non-conditional comments (`--`, `#`, `/* … */`, while preserving executable `/*! … */` conditional comments) so echoed SQL text in Messages always starts on the reported `startLine` across LF and CRLF files.
- **6 MB import JSON-envelope headroom:** raised the Fastify JSON `bodyLimit` on `POST /api/workspaces/:wsId/import` to 7 MB while keeping the raw SQL limit at 6 MB (`413 PAYLOAD_TOO_LARGE`), so ~5.9 MB `.sql` scripts with heavy newline/quote escaping no longer fail with HTTP 413.
- **Messages panel mutual clearing:** running a query now clears any previous Import summary card, and importing a script clears previous Run statement cards so Messages reflects only the latest action.

## [0.3.3] - 2026-11-20

### Added

- **README badge header:** added shields.io badges for the live website (`sql-scratchpad.com`), source repository, GitHub release, MIT license, Docker Hub image version, and CI workflow status.
- **Published multi-arch Docker Hub images:** added `.github/workflows/release.yml` (gated on full CI including Playwright E2E via `workflow_call`) to build and publish `0xwulf/sql-scratchpad` and `0xwulf/sql-scratchpad-db` for `linux/amd64` and `linux/arm64` on `v*.*.*` tags with `X.Y.Z`, `X.Y`, and `latest` tags, OCI image labels, SBOM + `provenance: mode=max` attestations, and automated Docker Hub overview syncing (`README.md` and `docs/DOCKERHUB-DB.md`).
- **Build-from-source Compose variant:** added `deploy/docker-compose.build.yml` for contributors and operators who prefer building images locally.

### Changed

- **Self-hosting via `docker compose pull`:** switched `deploy/docker-compose.yml` and `docs/SELF-HOSTING.md` to pull pinned multi-arch images (`0xwulf/sql-scratchpad:0.3.3` and `0xwulf/sql-scratchpad-db:0.3.3`) by default, keeping all container hardening intact.
- **Cross-platform app `Dockerfile`:** moved `base`, `builder`, and `prod-deps` onto `$BUILDPLATFORM` (`FROM --platform=$BUILDPLATFORM`) so TypeScript, Vite, and pure-JS dependency installation run natively without QEMU while `runtime` stays target-arch native.

## [0.3.2] - 2026-11-20

### Security

- **Per-IP live-workspace cap (`MAX_WORKSPACES_PER_IP`):** raised default from `3` to `6` (env-configurable; global cap stays `50`) to accommodate multiple users behind shared IPv4 / CGNAT and campus/office NAT while keeping per-key usage bounded.
- **Workspace create rate limit (`POST /api/workspaces`):** raised from `10/h` to `20/h` per client key (preserving the ~3.3× ratio to the live workspace cap) so shared-IPv4/CGNAT reloads with `pagehide` teardown and the full default-cap E2E suite do not trip `RATE_LIMITED`.
- **Ownership-checked beacon close (`POST /api/workspaces/:wsId/close`):** shares `DELETE` teardown semantics and `60/min` per-key rate limit, and verifies caller IP-key ownership (`403 FORBIDDEN` for non-owners) because `navigator.sendBeacon` uses CORS simple requests.

### Added

- **Best-effort workspace release on `pagehide`:** browser tabs now send `navigator.sendBeacon` to `POST /api/workspaces/:wsId/close` on `pagehide` to free live workspace slots promptly.
- **Visible `429`/`503` error UX:** rate-limit and capacity responses from create, reset, exec, and import now render the server message plus `"try again in N minute(s)"` (computed from `Retry-After`) in a dismissible alert banner, the status log, and the schema tree pane (never silently falling back to `"No workspace connected."`).
- **E2E cap-limit regression test:** added an end-to-end Playwright test that fills the default per-IP live workspace cap and asserts the visible `429` banner, status log, and schema error.

### Fixed

- **Single-workspace reuse per browser tab:** serialized initial workspace bootstrap against user actions so picking **Sample: Library**, **Empty DB**, a dataset from the dropdown, or **Import (fresh)** always resets the active workspace (`POST /reset`) instead of creating extra workspaces; a new workspace is created only if none exists or the server returns `404`.
- **E2E workspace hygiene & CI reliability:** every Playwright test now cleans up its workspaces in `afterEach`, and E2E runs with `workers: 1` against the default cap.

### Changed

- **GitHub Actions:** updated `actions/checkout` and `actions/setup-node` from `v4` to `v7` to remove the Node 20 runtime deprecation warning.

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
