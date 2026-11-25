#!/bin/sh
set -eu

if [ -z "${SQLSCRATCHPAD_ADMIN_PASSWORD:-}" ]; then
  echo "ERROR: SQLSCRATCHPAD_ADMIN_PASSWORD is not set" >&2
  exit 1
fi

case "${SQLSCRATCHPAD_ADMIN_PASSWORD}" in
  replace-with-*|REPLACE-WITH-*|changeme|CHANGEME|change-me|CHANGE-ME|password|PASSWORD)
    echo "ERROR: SQLSCRATCHPAD_ADMIN_PASSWORD is set to an insecure placeholder value" >&2
    exit 1
    ;;
esac

case "${MARIADB_ROOT_PASSWORD:-}" in
  ''|replace-with-*|REPLACE-WITH-*|changeme|CHANGEME|change-me|CHANGE-ME|password|PASSWORD)
    echo "ERROR: MARIADB_ROOT_PASSWORD is empty or set to an insecure placeholder value" >&2
    exit 1
    ;;
esac

# Reject CR/LF control characters and escape backslashes before single quotes for SQL string literal
NL=$(printf '\n_')
NL=${NL%_}
CR=$(printf '\r')
case "${SQLSCRATCHPAD_ADMIN_PASSWORD}" in
  *"${NL}"*|*"${CR}"*)
    echo "ERROR: SQLSCRATCHPAD_ADMIN_PASSWORD must not contain newline characters" >&2
    exit 1
    ;;
esac
ESCAPED_PWD=$(printf '%s' "${SQLSCRATCHPAD_ADMIN_PASSWORD}" | sed "s/\\\\/\\\\\\\\/g; s/'/''/g")

# Architectural note: MariaDB requires global CREATE USER to provision and drop
# ephemeral ws_<hex> workspace accounts. Treat scratchpad_admin as a privileged
# DB administration boundary (isolated to the internal network; never exposed).
# Remote TCP root ('root'@'%') is explicitly dropped; local socket root remains.
# Template schemas (tpl_*) grant read-only SELECT + SHOW VIEW (no TRIGGER write).
printf "DROP USER IF EXISTS 'root'@'%%';
CREATE USER IF NOT EXISTS 'scratchpad_admin'@'%%' IDENTIFIED BY '%s';
GRANT CREATE USER, CONNECTION ADMIN ON *.* TO 'scratchpad_admin'@'%%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER, CREATE TEMPORARY TABLES, LOCK TABLES, CREATE ROUTINE, ALTER ROUTINE, EXECUTE ON \`ws\\_%%\`.* TO 'scratchpad_admin'@'%%' WITH GRANT OPTION;
GRANT SELECT, SHOW VIEW ON \`tpl\\_%%\`.* TO 'scratchpad_admin'@'%%';
GRANT SELECT (User, Host) ON mysql.user TO 'scratchpad_admin'@'%%';
FLUSH PRIVILEGES;\n" "${ESCAPED_PWD}" | MYSQL_PWD="${MARIADB_ROOT_PASSWORD}" mariadb --protocol=socket -u root
echo "scratchpad_admin user provisioned."
