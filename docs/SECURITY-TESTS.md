# Security Test Results

This document records the automated hostile-SQL and abuse-resistance test suite executed against a real **MariaDB 11.4 LTS** instance (`server/src/hostile.int.test.ts` and `server/src/hardening.test.ts`, with fixtures in `server/src/fixtures/hostile-corpus.ts`).

Run locally against the dev database:

```bash
pnpm exec vitest run --project unit --project web
pnpm test:int
```

## Hostile SQL & Abuse Corpus Results

Every vector below is verified to be **denied or bounded** with a sensible error, leaving MariaDB healthy and an independent workspace running `SELECT 1` unaffected (and zero orphaned `ws_*` databases or users left behind).

| # | Vector | Layer(s) Tested | Expected & Observed Outcome | Result |
|---|---|---|---|---|
| 1 | `GRANT ALL PRIVILEGES ON *.*` | API pre-flight + direct MariaDB (`ws_*` user) | Denied (`PLAYGROUND_DENIED` at API; privilege error directly in MariaDB) | PASS |
| 2 | `REVOKE ALL PRIVILEGES ON *.*` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; privilege error directly in MariaDB) | PASS |
| 3 | `CREATE USER` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; privilege error directly in MariaDB) | PASS |
| 4 | `SET GLOBAL max_connections = 9999` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; privilege error directly in MariaDB) | PASS |
| 5 | `SET PASSWORD FOR 'root'@'localhost'` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; privilege error directly in MariaDB) | PASS |
| 6 | `SHUTDOWN` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; privilege error directly in MariaDB) | PASS |
| 7 | `CREATE FUNCTION ... SONAME` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; privilege error directly in MariaDB) | PASS |
| 8 | `INSTALL PLUGIN ... SONAME` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; privilege error directly in MariaDB) | PASS |
| 9 | `LOAD DATA INFILE '/etc/passwd'` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; no `FILE` privilege directly in MariaDB) | PASS |
| 10 | `LOAD DATA LOCAL INFILE '/etc/passwd'` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; `local_infile = 0` directly in MariaDB) | PASS |
| 11 | `SELECT ... INTO OUTFILE` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; errno `1227` / `secure_file_priv` directly in MariaDB) | PASS |
| 12 | `SELECT ... INTO DUMPFILE` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; errno `1227` / `secure_file_priv` directly in MariaDB) | PASS |
| 13 | `SELECT User, Host FROM mysql.user` | MariaDB privileges | Denied with errno `1142` (`ER_TABLEACCESS_DENIED_ERROR`) | PASS |
| 14 | `information_schema.SCHEMATA` & `TABLES` probing | MariaDB privileges | Workspace sees **only** its own `ws_*` schema; other `ws_*` and `tpl_*` schemas are invisible | PASS |
| 15 | `USE <other ws_*>` and `USE tpl_sample_library` | API pre-flight + direct MariaDB | Denied (`PLAYGROUND_DENIED` at API; errno `1044` directly in MariaDB) | PASS |
| 16 | `KILL <other threadId>` & `KILL QUERY <other threadId>` | MariaDB thread ownership | Denied with errno `1095` (`You are not owner of thread`) | PASS |
| 17 | Recursive CTE bomb (`WITH RECURSIVE ...`) | MariaDB `max_recursive_iterations = 1000` | Bounded at 1,000 iterations (< 3 s); DB healthy | PASS |
| 18 | 3-way cartesian join on imported 20,000-row table | MariaDB `MAX_STATEMENT_TIME = 5` | Aborted at ~5 s with errno `1969` (`ER_STATEMENT_TIMEOUT`); DB healthy | PASS |
| 19 | `BENCHMARK(1000000000, SHA2(..., 512))` | API pre-flight + direct MariaDB `MAX_STATEMENT_TIME = 5` | Denied immediately at API (`PLAYGROUND_DENIED`); direct MariaDB call bounded at ~5 s | PASS |
| 20 | `SLEEP(30)` storm (5 parallel requests across sessions A & B) | Per-session mutex (`409`) + `MAX_STATEMENT_TIME = 5` | 3 concurrent duplicates rejected immediately (`409 SESSION_BUSY`); 2 active sessions bounded at ~5 s; concurrent second workspace `SELECT 1` completes unaffected (< 2 s) | PASS |
| 21 | 6 MB + 1 byte import payload | Fastify route body limit (6 MB) | Rejected with HTTP `413 PAYLOAD_TOO_LARGE` | PASS |
| 22 | 60,001-statement import script | Import statement cap (`60,000`) | Rejected before execution with HTTP `400 TOO_MANY_STATEMENTS` | PASS |
| 23 | `DELIMITER` abuse smuggling `GRANT` | `dbgate-query-splitter` + pre-flight denylist | Parsed cleanly without hang; smuggled `GRANT` denied | PASS |
| 24 | Deeply nested / repeated comments (`2,000` blocks) + `/*!50000 GRANT ... */` | Comment stripper + pre-flight denylist | Parsed in < 3 s without catastrophic backtracking; conditional-comment `GRANT` denied (`PLAYGROUND_DENIED`) | PASS |
| 25 | 5 MB single-statement string literal | `/exec` 256 KB limit + MariaDB `max_allowed_packet = 4M` | Rejected with HTTP `413` on `/exec`; rejected cleanly on `/import` by `max_allowed_packet` with DB healthy | PASS |

## Hardening, Rate-Limit & Privacy Verification

| Control | Verification | Result |
|---|---|---|
| Connection budget (`max_connections = 150`) | `SHOW VARIABLES LIKE 'max_connections'` = `150` | PASS |
| Global live-workspace cap (50) | Returns HTTP `503` `"SQL Scratchpad is busy, try again in a few minutes"` | PASS |
| Per-IP live-workspace cap (3) | 4th create returns HTTP `429` with `Retry-After` and `"close a workspace or wait for it to expire"`; deleting one restores slot | PASS |
| Per-IP route rate limits (`10/h` create, `60/min` exec, `20/h` + `30 MB/h` import, `120/min` schema) | Exceeded requests return HTTP `429` with `Retry-After` header | PASS |
| Real client IP (`TRUST_PROXY`) | Empty `TRUST_PROXY` ignores spoofed `X-Forwarded-For`; non-empty list trusts only listed IPs/CIDRs and rejects boolean/named values | PASS |
| TTLs & idle session rollback | Default `2 h` idle / `12 h` absolute workspace TTL, `10 min` idle pinned-session close (rolls back open transactions), `5 min` janitor | PASS |
| Privacy in logs & memory | Client IPs hashed via 16-hex truncated SHA-256 with in-memory random salt rotated daily (UTC); grep of hostile-corpus app logs shows **0 hits** for SQL corpus keywords and **0 hits** for raw IPv4 addresses | PASS |
| Maintenance kill switch (`MAINTENANCE=1`) | `/api/*` returns HTTP `503` (`MAINTENANCE`), `/api/health` returns `{"status":"maintenance",...}`, static UI (`GET /`) loads normally and displays maintenance banner | PASS |
