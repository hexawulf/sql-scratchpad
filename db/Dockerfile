# MariaDB 11.4.13-noble multi-arch OCI index (linux/arm64/v8 + linux/amd64)
FROM mariadb:13.0@sha256:54f493ea0d60b621a5bff84e5b20100f8b86b6efa6b79158e04756c5194a5e4d

RUN mkdir -p /var/lib/mysql-files-disabled ; chown mysql:mysql /var/lib/mysql-files-disabled ; chmod 700 /var/lib/mysql-files-disabled

COPY db/conf.d/sql-scratchpad.cnf /etc/mysql/conf.d/sql-scratchpad.cnf
COPY db/init/00-admin-user.sh /docker-entrypoint-initdb.d/00-admin-user.sh
COPY db/init/10-sample-library.sh /docker-entrypoint-initdb.d/10-sample-library.sh
COPY seeds/sample-library.sql /opt/sql-scratchpad-seeds/sample-library.sql
RUN chmod 755 /docker-entrypoint-initdb.d/00-admin-user.sh /docker-entrypoint-initdb.d/10-sample-library.sh ; chmod 644 /opt/sql-scratchpad-seeds/sample-library.sql
