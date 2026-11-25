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
echo "tpl_sample_library seeded from ${SEED_FILE}."
