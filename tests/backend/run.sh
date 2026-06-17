#!/bin/sh
# Backend test entrypoint -- works the same on CI and locally.
#
#   sh tests/backend/run.sh
#
# Spins up the PHP built-in webserver against a throw-away SQLite database
# pinned via MCMINDMAP_DB, runs the case file, and tears down on exit.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DB="${MCMINDMAP_DB:-/tmp/test-mindmap.db}"
PORT="${PORT:-8765}"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$DB"
export MCMINDMAP_DB="$DB"
export APP_URL="$BASE"   # so share_link returns a sane URL

php "$ROOT/tests/backend/seed.php"

echo "starting php server on ${BASE} (docroot: ${ROOT})"
php -S "127.0.0.1:${PORT}" -t "$ROOT" >/tmp/mindmap-test-server.log 2>&1 &
SERVER_PID=$!

# wait for the server to come up
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s -o /dev/null "${BASE}/api/index.php?action=me"; then break; fi
    sleep 0.3
done

API_BASE="${BASE}/api/index.php" php "$ROOT/tests/backend/cases.php"
