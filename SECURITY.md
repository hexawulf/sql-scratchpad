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
| Bulk import abuse | Route-only 6 MB body limit (`/exec` stays at 256 KB), 60,000 statement cap, 90 s wall-clock cap, per-IP rate limit (20 imports/hour) plus a rolling 30 MB/hour byte budget (`429` with `Retry-After`). Imports always run on the workspace user, never the admin account. |
| Workspace flooding | Global cap of 50 live workspaces (`503` when full), idle workspace expiration, and per-IP create rate limit (10/hour). |
| Credential and SQL leakage | Split least-privilege env files (`MARIADB_ROOT_PASSWORD` is never passed to the app container). Workspace passwords live in API memory only. Pino log redaction strips SQL and password fields; logs record only byte length and a truncated SHA-256 hash. |
| Network exposure | MariaDB runs on an `internal: true` Docker network with no host port mapping. The app binds `127.0.0.1:5050` by default and serves same-origin only. |
| XSS via query results | The result grid and modals render text nodes only (no `v-html`). Strict CSP (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. |
| Container hardening | Non-root runtime user (`USER node`), `read_only: true` root filesystem with `/tmp` tmpfs, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, and base images pinned by multi-arch OCI digest. |
