#!/bin/sh
set -eu

if [ -z "${SQLSCRATCHPAD_ADMIN_PASSWORD:-}" ]; then
  echo "ERROR: SQLSCRATCHPAD_ADMIN_PASSWORD is not set" >&2
  exit 1
fi

# Escape single quotes for SQL string literal
ESCAPED_PWD=$(printf '%s' "${SQLSCRATCHPAD_ADMIN_PASSWORD}" | sed "s/'/''/g")

mariadb --protocol=socket -u root -p"${MARIADB_ROOT_PASSWORD}" -e "
CREATE USER IF NOT EXISTS 'scratchpad_admin'@'%' IDENTIFIED BY '${ESCAPED_PWD}';
GRANT CREATE USER, CONNECTION ADMIN ON *.* TO 'scratchpad_admin'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER, CREATE TEMPORARY TABLES, LOCK TABLES, CREATE ROUTINE, ALTER ROUTINE, EXECUTE ON \`ws\\_%\`.* TO 'scratchpad_admin'@'%' WITH GRANT OPTION;
GRANT SELECT, SHOW VIEW, TRIGGER ON \`tpl\\_%\`.* TO 'scratchpad_admin'@'%';
GRANT SELECT (User, Host) ON mysql.user TO 'scratchpad_admin'@'%';
FLUSH PRIVILEGES;"
echo "scratchpad_admin user provisioned."
