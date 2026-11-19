# Self-Hosting SQLyard

SQLyard runs as two Docker containers built directly from this repository — no external container registry account is required:

- **`sqlyard-db:local`** — MariaDB 11.4 LTS with conservative memory settings and the `sample-library` template database.
- **`sqlyard:local`** — Node 24 Fastify API + prebuilt Vue 3 static SPA.

## Resource Requirements

- **Memory:** ~512 MB limit for MariaDB + ~192 MB limit for the app (~120–150 MB combined at idle).
- **CPU:** 1–2 vCPUs (runs smoothly on ARM64 SBCs as well as x86_64 servers).
- **Disk:** ~700 MB for images plus up to 1 GB temporary workspace budget.
- **Software:** Docker Engine 24+ and Docker Compose v2.

## Quick Start

1. **Clone the repository:**

   ```bash
   git clone https://github.com/hexawulf/sqlyard.git
   cd sqlyard
   ```

2. **Create least-privilege environment files from the examples:**

   ```bash
   cp deploy/db.env.example deploy/db.env
   cp deploy/app.env.example deploy/app.env
   chmod 600 deploy/db.env deploy/app.env
   ```

3. **Generate strong random passwords:**

   ```bash
   openssl rand -base64 32   # use for MARIADB_ROOT_PASSWORD (db.env only)
   openssl rand -base64 32   # use for SQLYARD_ADMIN_PASSWORD (identical in db.env and app.env)
   ```

   Edit `deploy/db.env` and `deploy/app.env` with those generated values. Never place `MARIADB_ROOT_PASSWORD` in `deploy/app.env`.

4. **Build and start the stack:**

   ```bash
   docker compose -f deploy/docker-compose.yml up -d --build
   ```

5. **Verify health:**

   ```bash
   curl -s http://127.0.0.1:5050/api/health
   # Expected: {"status":"ok","db":"ok","version":"0.2.0"}
   ```

   Open `http://127.0.0.1:5050` in your browser.

## Environment Variables

### `deploy/db.env`

| Variable | Required | Description |
|---|---|---|
| `MARIADB_ROOT_PASSWORD` | Yes | MariaDB root password (used only inside the DB container during init). |
| `SQLYARD_ADMIN_PASSWORD` | Yes | Password for the `sqlyard_admin` account; must match `deploy/app.env`. |

### `deploy/app.env`

| Variable | Default | Description |
|---|---|---|
| `SQLYARD_ADMIN_PASSWORD` | *(required)* | Admin pool password matching `deploy/db.env`. |
| `DB_HOST` | `db` | MariaDB service hostname on the internal Docker network. |
| `DB_PORT` | `3306` | MariaDB service port. |
| `HOST` | `0.0.0.0` | Listen address inside the app container. |
| `PORT` | `5050` | Listen port inside the app container. |
| `TRUST_PROXY` | *(empty)* | Set to your reverse proxy IP/CIDR (e.g. `127.0.0.1`) when behind nginx/Caddy so per-IP rate limits use the real client IP. Leave empty when accessed directly. |
| `LOG_LEVEL` | `info` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`). |
| `WORKSPACE_TTL_MS` | `86400000` | Idle workspace TTL in ms (set `7200000` for 2 hours on public instances). |
| `SESSION_IDLE_TTL_MS` | `900000` | Idle pinned session timeout in ms (15 min default; rolls back open transactions). |
| `MAX_WORKSPACES` | `50` | Maximum concurrent live workspaces before returning HTTP `503`. |
| `MAX_WORKSPACE_BYTES` | `52428800` | Per-workspace disk cap in bytes (50 MB). |
| `IMPORT_TIMEOUT_MS` | `90000` | Wall-clock cap for `POST /api/workspaces/:wsId/import` (90 s). |
| `IMPORT_MAX_STATEMENTS` | `60000` | Maximum statements per imported `.sql` file. |
| `IMPORT_BYTE_BUDGET_PER_HOUR` | `31457280` | Per-IP rolling hourly import byte budget (30 MB). |

## Placing Behind a Reverse Proxy

By default, `deploy/docker-compose.yml` binds `127.0.0.1:5050`. When exposing SQLyard over HTTPS behind nginx or Caddy:

- Allow bodies up to **7 MB** (`client_max_body_size 7m;` in nginx) so 6 MB `.sql` imports succeed.
- Set proxy read timeout to at least **120 s** (`proxy_read_timeout 120s;`) for large imports and lock-wait queries.
- Forward the real client IP (`X-Forwarded-For` / `X-Real-IP`) and set `TRUST_PROXY` in `deploy/app.env` to your proxy's IP.
- Do not duplicate security headers (`Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`); the app container sets them directly.

## Updating and Resetting

- **Code-only upgrade:**

  ```bash
  git pull
  docker compose -f deploy/docker-compose.yml up -d --build
  ```

- **Full database reset** (required only when `seeds/sample-library.sql` or `db/init/` changes):

  ```bash
  docker compose -f deploy/docker-compose.yml down -v
  docker compose -f deploy/docker-compose.yml up -d --build
  ```

  Workspaces are ephemeral by design, so no database backup is needed.
