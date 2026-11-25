# Self-Hosting SQL Scratchpad

SQL Scratchpad runs as two prebuilt multi-arch (`linux/amd64`, `linux/arm64`) Docker images published on Docker Hub — no local Node.js or build toolchain is required:

- **`0xwulf/sql-scratchpad-db:0.3.8`** — MariaDB 11.4 LTS with conservative memory settings and the `sample-library` template database.
- **`0xwulf/sql-scratchpad:0.3.8`** — Node 24 Fastify API + prebuilt Vue 3 static SPA.

## Resource Requirements

- **Memory:** ~512 MB limit for MariaDB + ~192 MB limit for the app (~120–150 MB combined at idle).
- **CPU:** 1–2 vCPUs (runs smoothly on ARM64 SBCs as well as x86_64 servers).
- **Disk:** ~700 MB for images plus up to 1 GB temporary workspace budget.
- **Software:** Docker Engine 24+ and Docker Compose v2.

## Quick Start (Prebuilt Docker Hub Images)

1. **Clone the repository** (or copy `deploy/docker-compose.yml`, `deploy/db.env.example`, and `deploy/app.env.example`):

   ```bash
   git clone https://github.com/hexawulf/sql-scratchpad.git
   cd sql-scratchpad
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
   openssl rand -base64 32   # use for SQLSCRATCHPAD_ADMIN_PASSWORD (identical in db.env and app.env)
   ```

   Edit `deploy/db.env` and `deploy/app.env` with those generated values. Never place `MARIADB_ROOT_PASSWORD` in `deploy/app.env`.

4. **Pull and start the stack:**

   ```bash
   docker compose -f deploy/docker-compose.yml pull ; docker compose -f deploy/docker-compose.yml up -d
   ```

5. **Verify health:**

   ```bash
   curl -s http://127.0.0.1:5050/api/health
   # Expected: {"status":"ok","db":"ok","version":"0.3.8"}
   ```

   Open `http://127.0.0.1:5050` in your browser.

## Building From Source

Contributors or operators who prefer to build images locally instead of pulling from Docker Hub can use `deploy/docker-compose.build.yml` (same hardening and network isolation, tagged `sql-scratchpad:local` and `sql-scratchpad-db:local`):

```bash
docker compose -f deploy/docker-compose.build.yml up -d --build
```

## Environment Variables

### `deploy/db.env`

| Variable | Required | Description |
|---|---|---|
| `MARIADB_ROOT_PASSWORD` | Yes | MariaDB root password (used only inside the DB container during init). |
| `SQLSCRATCHPAD_ADMIN_PASSWORD` | Yes | Password for the `scratchpad_admin` account; must match `deploy/app.env`. |

### `deploy/app.env`

| Variable | Default | Description |
|---|---|---|
| `SQLSCRATCHPAD_ADMIN_PASSWORD` | *(required)* | Admin pool password matching `deploy/db.env`. |
| `DB_HOST` | `db` | MariaDB service hostname on the internal Docker network. |
| `DB_PORT` | `3306` | MariaDB service port. |
| `HOST` | `0.0.0.0` | Listen address inside the app container. |
| `PORT` | `5050` | Listen port inside the app container. |
| `TRUST_PROXY` | *(empty)* | Comma-separated IP/CIDR list of trusted reverse proxies that send `X-Forwarded-For` (Fastify ignores `X-Real-IP`). When running `app` in Docker behind a host reverse proxy, use the Docker `edge` network gateway IP/CIDR (see below), not `127.0.0.1`. Forwarded headers are ignored completely when empty. |
| `LOG_LEVEL` | `info` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`). Client IPs are logged only as daily-salted SHA-256 hashes. |
| `WORKSPACE_TTL_MS` | `7200000` | Idle workspace TTL in ms (default **2 hours**). |
| `WORKSPACE_MAX_TTL_MS` | `43200000` | Absolute maximum workspace lifetime in ms (default **12 hours**). |
| `SESSION_IDLE_TTL_MS` | `600000` | Idle pinned session timeout in ms (default **10 minutes**; rolls back open transactions). |
| `JANITOR_INTERVAL_MS` | `300000` | Background janitor sweep interval in ms (default **5 minutes**). |
| `MAX_WORKSPACES` | `50` | Maximum concurrent live workspaces globally before returning HTTP `503`. |
| `MAX_WORKSPACES_PER_IP` | `6` | Maximum concurrent live workspaces per client key (IPv4 or IPv6 prefix) before returning HTTP `429` with `Retry-After`. Defaults to `6` to accommodate shared IPv4 / CGNAT and campus/office NAT while keeping per-key usage bounded. |
| `IPV6_PREFIX_BITS` | `64` | Prefix length (`1`–`128`) used to collapse native IPv6 client addresses before hashing for rate limits and workspace ownership. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is unwrapped to plain IPv4 first. |
| `MAX_WORKSPACE_BYTES` | `52428800` | Per-workspace disk cap in bytes (50 MB). |
| `IMPORT_TIMEOUT_MS` | `75000` | Wall-clock cap for `POST /api/workspaces/:wsId/import` (75 s, leaving margin under upstream ~100 s CDN/proxy timeouts). |
| `IMPORT_MAX_STATEMENTS` | `60000` | Maximum statements per imported `.sql` file. |
| `IMPORT_BYTE_BUDGET_PER_HOUR` | `31457280` | Per-IP rolling hourly import byte budget (30 MB). |
| `MAINTENANCE` | `0` | Set to `1` to enable maintenance mode: all `/api/*` routes except `/api/health` return `503`, `/api/health` returns `{"status":"maintenance"}`, and the static UI displays a maintenance banner. |

## Placing Behind a Reverse Proxy

By default, `deploy/docker-compose.yml` binds `127.0.0.1:5050`. When exposing SQL Scratchpad over HTTPS behind nginx or Caddy:

- **Terminate TLS 1.2+/1.3** at the reverse proxy, redirect HTTP (`:80`) to HTTPS (`:443`), and send `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
- **Allow bodies up to 7 MB** (`client_max_body_size 7m;` in nginx) so 6 MB `.sql` imports succeed.
- **Set proxy read timeout to at least 120 s** (`proxy_read_timeout 120s;`) for large imports and lock-wait queries.
- **Forward `X-Forwarded-For` (not `X-Real-IP` alone):** Fastify reads `X-Forwarded-For` and ignores `X-Real-IP`. On a single-hop proxy, overwrite the header with `$remote_addr` so clients cannot spoof earlier hops; behind a CDN/edge proxy, use `set_real_ip_from` + `real_ip_header` on nginx before forwarding.
- **Set `TRUST_PROXY` to the Docker `edge` gateway IP/CIDR, not `127.0.0.1`:** Because the `app` container receives host-proxied traffic over the Docker bridge network, its peer address is the `edge` bridge gateway (for example `172.18.0.1` or its `/16` subnet), not `127.0.0.1`. Inspect it with:

  ```bash
  docker network inspect sql-scratchpad_edge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
  ```

  Then set `TRUST_PROXY=<gateway-ip>` (for example `TRUST_PROXY=172.18.0.1`) in `deploy/app.env`.
- **Do not duplicate app security headers:** The app container emits `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and `Cross-Origin-Resource-Policy` on both static and `/api/*` responses.

### Example: nginx

```nginx
server {
  listen 80;
  listen [::]:80;
  server_name sql-scratchpad.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name sql-scratchpad.example.com;

  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_certificate     /etc/ssl/certs/sql-scratchpad.pem;
  ssl_certificate_key /etc/ssl/private/sql-scratchpad.key;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  client_max_body_size 7m;

  location / {
    proxy_pass http://127.0.0.1:5050;
    proxy_http_version 1.1;
    proxy_read_timeout 120s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Single-hop proxy: overwrite X-Forwarded-For so clients cannot prepend spoofed IPs.
    # If behind a CDN, configure set_real_ip_from/real_ip_header and use $proxy_add_x_forwarded_for.
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

### Example: Caddy

```caddyfile
sql-scratchpad.example.com {
  header Strict-Transport-Security "max-age=31536000; includeSubDomains"
  request_body {
    max_size 7MB
  }
  reverse_proxy 127.0.0.1:5050 {
    transport http {
      response_header_timeout 120s
    }
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto https
  }
}
```

## Updating and Resetting

- **Release upgrade (prebuilt images):** bump the pinned version tags in `deploy/docker-compose.yml` (or `git pull` a new release tag), then pull and recreate:

  ```bash
  docker compose -f deploy/docker-compose.yml pull ; docker compose -f deploy/docker-compose.yml up -d
  ```

- **Build-from-source upgrade:**

  ```bash
  git pull
  docker compose -f deploy/docker-compose.build.yml up -d --build
  ```

- **Full database reset** (required only when `seeds/sample-library.sql` or `db/init/` changes):

  ```bash
  docker compose -f deploy/docker-compose.yml down -v
  docker compose -f deploy/docker-compose.yml pull ; docker compose -f deploy/docker-compose.yml up -d
  ```

  Workspaces are ephemeral by design, so no database backup is needed.

## Maintenance Kill Switch

- **Soft kill switch (keeps static UI online with a maintenance banner):** set `MAINTENANCE=1` in `deploy/app.env` and recreate the app container (`docker compose -f deploy/docker-compose.yml up -d app`). All `/api/*` endpoints except `/api/health` return HTTP `503`, and `/api/health` reports `{"status":"maintenance",...}`.
- **Hard stop:** `docker compose -f deploy/docker-compose.yml stop app`.
