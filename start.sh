#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-4317}"
AUTO_REFRESH_INTERVAL="${AUTO_REFRESH_INTERVAL:-5m}"
PIDS="$(lsof -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true)"

if [[ -n "${PIDS}" ]]; then
  echo "Stopping existing service on port ${PORT}: ${PIDS}"
  kill ${PIDS}
  sleep 1
fi

export PORT
export AUTO_REFRESH_INTERVAL

echo "Starting Codex token monitor on http://localhost:${PORT}"
echo "Auto refresh interval: ${AUTO_REFRESH_INTERVAL}"
nohup npm start > codex-token-monitor.log 2>&1 &
PID="$!"
echo "${PID}" > codex-token-monitor.pid

echo "Started in background. PID: ${PID}"
echo "Log: $(pwd)/codex-token-monitor.log"
