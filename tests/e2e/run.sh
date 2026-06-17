#!/bin/sh
# E2E entrypoint -- seeds a fresh DB, starts the PHP server, runs Playwright.
# Identical local + CI behaviour: the only thing CI brings is Chromium and PHP
# already installed.
#
#   sh tests/e2e/run.sh
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DB="${MCMINDMAP_DB:-/tmp/test-mindmap-e2e.db}"
PORT="${PORT:-8765}"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$DB"
export MCMINDMAP_DB="$DB"
export APP_URL="$BASE"        # so share links resolve to the test server
export BASE_URL="$BASE"       # consumed by playwright.config.js

php "$ROOT/tests/backend/seed.php"

echo "starting php server on ${BASE}"
php -S "127.0.0.1:${PORT}" -t "$ROOT" >/tmp/mindmap-e2e-server.log 2>&1 &
SERVER_PID=$!

for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s -o /dev/null "${BASE}/api/index.php?action=me"; then break; fi
    sleep 0.3
done

cd "$ROOT/tests/e2e"
if [ ! -d node_modules ]; then
    npm install --no-audit --no-fund --silent
fi
npx playwright test
