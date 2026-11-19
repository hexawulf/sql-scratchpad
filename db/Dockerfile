# MariaDB 11.4.13-noble multi-arch OCI index (linux/arm64/v8 + linux/amd64)
FROM mariadb:11.4@sha256:5e73baf8179b29f115101bb102763a47a017361f3e9792daccba6646c3ab1532

RUN mkdir -p /var/lib/mysql-files-disabled ; chown mysql:mysql /var/lib/mysql-files-disabled ; chmod 700 /var/lib/mysql-files-disabled

COPY db/conf.d/sqlyard.cnf /etc/mysql/conf.d/sqlyard.cnf
COPY db/init/00-admin-user.sh /docker-entrypoint-initdb.d/00-admin-user.sh
COPY db/init/10-sample-library.sh /docker-entrypoint-initdb.d/10-sample-library.sh
COPY seeds/sample-library.sql /opt/sqlyard-seeds/sample-library.sql
RUN chmod 755 /docker-entrypoint-initdb.d/00-admin-user.sh /docker-entrypoint-initdb.d/10-sample-library.sh ; chmod 644 /opt/sqlyard-seeds/sample-library.sql
