#!/bin/sh
set -eu

SEED_FILE="/opt/sql-scratchpad-seeds/sample-library.sql"

if [ ! -f "${SEED_FILE}" ]; then
  echo "ERROR: Seed file not found at ${SEED_FILE}" >&2
  exit 1
fi

printf '%s\n' "CREATE DATABASE IF NOT EXISTS tpl_sample_library CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" \
  | MYSQL_PWD="${MARIADB_ROOT_PASSWORD}" mariadb --protocol=socket -u root
MYSQL_PWD="${MARIADB_ROOT_PASSWORD}" mariadb --protocol=socket -u root tpl_sample_library < "${SEED_FILE}"

# scratchpad_admin has only SELECT + SHOW VIEW on tpl_* (no TRIGGER, AUTHZ-005), so it
# cannot see template triggers and workspace clones would silently lack them. Refuse a
# template with triggers instead of shipping a broken dataset.
TRIGGERS=$(printf '%s\n' "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = 'tpl_sample_library';" \
  | MYSQL_PWD="${MARIADB_ROOT_PASSWORD}" mariadb --protocol=socket -u root -N)
if [ "${TRIGGERS}" != "0" ]; then
  echo "ERROR: tpl_sample_library defines ${TRIGGERS} trigger(s); templates must not use triggers" >&2
  exit 1
fi
echo "tpl_sample_library seeded from ${SEED_FILE}."
