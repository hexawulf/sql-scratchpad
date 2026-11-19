# Security Policy

## Reporting a Vulnerability

If you discover a security issue in SQL Scratchpad, please email **dev@0xwulf.dev** with reproduction steps and impact details instead of opening a public issue. We will acknowledge reports promptly and coordinate a fix before disclosure.

---

## Threat Model & Controls

SQL Scratchpad executes **arbitrary user-supplied SQL** on a real MariaDB 11.4 server. The defense-in-depth controls below are designed around untrusted input:

| Threat | Control |
|---|---|
| Reading or modifying other workspaces or templates | Per-workspace database (`ws_<hex>`) and dedicated MariaDB user granted privileges on that database only. Templates (`tpl_*`) are readable only by `scratchpad_admin`. Integration tests assert cross-workspace and template access fail with MariaDB errno `1142`. |
| Reading or writing host files (`LOAD DATA`, `INTO OUTFILE`) | `FILE` privilege is never granted, `local_infile = 0`, `secure_file_priv` points to an empty `0700` directory, and a pre-flight denylist rejects file/admin statements cleanly. |
| CPU exhaustion (slow queries, recursive CTEs) | `MAX_STATEMENT_TIME = 5` on every workspace account and session, `max_recursive_iterations = 1000`, `KILL QUERY` endpoint, container CPU cap (`cpus: 1.5`), and per-IP rate limits. |
| Memory exhaustion | Tuned MariaDB buffer settings (`innodb_buffer_pool_size = 96M`, `performance_schema = OFF`), container `mem_limit` (`512m` DB / `192m` app), 1,000-row result cap, and 5 MB response cap. |
| Disk exhaustion | Janitor checks `SUM(data_length + index_length)` per workspace every 5 min and resets workspaces over **50 MB**. Total workspace storage budget (1 GB) refuses new workspaces with HTTP `503`. |
| Bulk import abuse | Route-only 6 MB body limit (`/exec` stays at 256 KB), 60,000 statement cap, **75 s** wall-clock cap (`IMPORT_TIMEOUT_MS`, leaving margin under ~100 s CDN/proxy timeouts), per-key rate limit (20 imports/hour) plus a rolling 30 MB/hour byte budget (`429` with `Retry-After`). Imports always run on the workspace user, never the admin account. |
| Workspace flooding & abuse | Global cap of **50** live workspaces (`503` "SQL Scratchpad is busy, try again in a few minutes"), per-key cap of **6** live workspaces (`MAX_WORKSPACES_PER_IP`, default `6`, env-configurable — sized to accommodate multiple users behind shared IPv4 / CGNAT or campus/office NAT while bounding per-key abuse; returns `429` with `Retry-After` and hint to close a workspace or wait), **2 h** idle TTL / **12 h** absolute max lifetime, **10 min** idle pinned-session timeout (open transactions rolled back), `max_connections = 150`, and per-key rate limits (create `20/h`, reset `10/h`, exec `60/min`, import `20/h` + `30 MB/h`, schema `120/min`, kill `60/min`, close `60/min` ownership-checked by IP key, delete `60/min`, all returning `429` with `Retry-After`). Client addresses are normalised before hashing: IPv4 as-is, IPv4-mapped IPv6 (`::ffff:a.b.c.d`) unwrapped to IPv4, native IPv6 collapsed to `/64` (`IPV6_PREFIX_BITS`). |
| Proxy & IP spoofing | Fastify `trustProxy` trusts **only** explicit IP/CIDR entries in `TRUST_PROXY` (invalid/boolean values are rejected at startup). When `TRUST_PROXY` is empty, `X-Forwarded-*` headers are ignored completely. |
| Static file exposure | Static SPA handler refuses dotfiles/dot-directories and path traversal segments with HTTP `404` directly inside the application, independent of reverse-proxy rules. |
| Credential, SQL, and IP leakage | Split least-privilege env files (`MARIADB_ROOT_PASSWORD` is never passed to the app container). Workspace passwords live in API memory only. Pino log redaction strips SQL and password fields; SQL is logged only as byte length + truncated SHA-256. Client IPs are never stored or logged in plaintext — request logs use a 16-hex truncated SHA-256 hash with a daily-rotated (UTC) in-memory salt, while rate-limit and workspace-ownership keys use a separate process-lifetime in-memory random salt (never rotated, never logged). |
| Emergency kill switch | Setting `MAINTENANCE=1` makes every `/api/*` route except `/api/health` return HTTP `503` while `/api/health` reports `{"status":"maintenance"}` and the static UI shows a maintenance banner. |
| Network exposure | MariaDB runs on an `internal: true` Docker network with no host port mapping. The app binds `127.0.0.1:5050` by default and serves same-origin only. |
| XSS via query results | The result grid and modals render text nodes only (no `v-html`). Strict CSP (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. |
| Container hardening | Non-root runtime user (`USER node`), `read_only: true` root filesystem with `/tmp` tmpfs, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, and base images pinned by multi-arch OCI digest. |

## Security Test Results

Automated hostile-SQL and abuse-resistance tests run in CI against real MariaDB 11.4. See [docs/SECURITY-TESTS.md](docs/SECURITY-TESTS.md) for the full corpus and verification results.
