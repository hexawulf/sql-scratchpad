# MariaDB 11.4.13-noble multi-arch OCI index (linux/arm64/v8 + linux/amd64)
FROM mariadb:11.4@sha256:a8992b5e5404d11e03c54a31d0c1bdea3fd116d283aa6d1a627551f29045309b

RUN mkdir -p /var/lib/mysql-files-disabled && chown root:root /var/lib/mysql-files-disabled && chmod 555 /var/lib/mysql-files-disabled

COPY db/conf.d/sql-scratchpad.cnf /etc/mysql/conf.d/sql-scratchpad.cnf
COPY db/init/00-admin-user.sh /docker-entrypoint-initdb.d/00-admin-user.sh
COPY db/init/10-sample-library.sh /docker-entrypoint-initdb.d/10-sample-library.sh
COPY seeds/sample-library.sql /opt/sql-scratchpad-seeds/sample-library.sql
RUN chmod 755 /docker-entrypoint-initdb.d/00-admin-user.sh /docker-entrypoint-initdb.d/10-sample-library.sh ; chmod 644 /opt/sql-scratchpad-seeds/sample-library.sql

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD ["healthcheck.sh", "--connect", "--innodb_initialized"]
