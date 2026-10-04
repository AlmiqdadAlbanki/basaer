#!/usr/bin/env bash
# Reliable dev restart: kill whatever holds the port, wait until it is truly
# free, start exactly one detached server, and wait until it answers.
set -u
PORT="${PORT:-3000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${LOG:-/tmp/basaer.log}"

cd "$ROOT"

# Kill by port and by command, then wait for the port to free up.
fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
pkill -9 -f "node server/index.js" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  if ! ss -ltn 2>/dev/null | grep -q ":${PORT} "; then break; fi
  sleep 0.2
done
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "ERROR: port ${PORT} still in use"; ss -ltnp | grep ":${PORT} "; exit 1
fi

# Start one detached server.
setsid nohup node server/index.js >"$LOG" 2>&1 < /dev/null &

# Wait for health.
for _ in $(seq 1 50); do
  if curl -sf "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
    echo "server up on http://localhost:${PORT}  (pid $(pgrep -f 'node server/index.js' | head -1))"
    exit 0
  fi
  sleep 0.2
done
echo "ERROR: server did not come up; log:"; cat "$LOG"; exit 1
