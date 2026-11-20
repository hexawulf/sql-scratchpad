# SQL Scratchpad DB (`0xwulf/sql-scratchpad-db`)

Database companion image for **[SQL Scratchpad](https://sql-scratchpad.com)** — a lightweight, Letos-style SQL playground in the browser backed by isolated MariaDB workspaces.

## What Is Inside

- **MariaDB 11.4 LTS** multi-arch base (`linux/amd64`, `linux/arm64`).
- Hardened server configuration (`/etc/mysql/conf.d/sql-scratchpad.cnf`) tuned for ephemeral, least-privilege workspace databases (`ws_*`) with conservative memory limits and `local_infile` / file-I/O disabled.
- Init scripts that provision the least-privilege `scratchpad_admin` account and load the built-in `sample-library` template database (`tpl_sample_library`).

## Usage

This image is designed to run alongside the application image **[`0xwulf/sql-scratchpad`](https://hub.docker.com/r/0xwulf/sql-scratchpad)** via Docker Compose on an internal-only Docker network — it is not intended as a standalone general-purpose MariaDB server.

See the repository and self-hosting guide for the full hardened `docker-compose.yml` and environment file setup:

- **Source & Compose files:** https://github.com/hexawulf/sql-scratchpad
- **Self-Hosting Guide:** https://github.com/hexawulf/sql-scratchpad/blob/main/docs/SELF-HOSTING.md
- **App Image:** https://hub.docker.com/r/0xwulf/sql-scratchpad
- **Live Demo:** https://sql-scratchpad.com

## License

MIT — see [LICENSE](https://github.com/hexawulf/sql-scratchpad/blob/main/LICENSE).
