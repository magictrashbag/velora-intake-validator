#!/usr/bin/env bash
# Start a throwaway local Postgres 16 for tests (no Docker needed).
#   scripts/test-db.sh start   -> prints the DATABASE_URL to export
#   scripts/test-db.sh stop
set -euo pipefail
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
DATA=${PGDATA_DIR:-$HOME/.kame-test-pg}
PORT=${PGPORT:-54329}
RUN=""
if [ "$(id -u)" = 0 ]; then
  # Postgres refuses to run as root; use the postgres system user and its home.
  RUN="runuser -u postgres --"
  DATA=${PGDATA_DIR:-/var/lib/postgresql/kame-test}
fi
case "${1:-start}" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      $RUN mkdir -p "$DATA"
      $RUN "$PGBIN/initdb" -D "$DATA" -U kame --auth=trust >/dev/null
    fi
    $RUN "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=localhost" -l "$DATA/log" -w start >/dev/null
    echo "export DATABASE_URL=postgres://kame@localhost:$PORT/postgres"
    ;;
  stop) $RUN "$PGBIN/pg_ctl" -D "$DATA" -m fast stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
