#!/bin/sh
set -eu

SEED_FILE="/opt/sql-scratchpad-seeds/sample-library.sql"

if [ ! -f "${SEED_FILE}" ]; then
  echo "ERROR: Seed file not found at ${SEED_FILE}" >&2
  exit 1
fi

mariadb --protocol=socket -u root -p"${MARIADB_ROOT_PASSWORD}" -e \
  "CREATE DATABASE IF NOT EXISTS tpl_sample_library CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mariadb --protocol=socket -u root -p"${MARIADB_ROOT_PASSWORD}" tpl_sample_library < "${SEED_FILE}"
echo "tpl_sample_library seeded from ${SEED_FILE}."
