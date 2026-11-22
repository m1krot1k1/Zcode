#!/usr/bin/env bash
# Stop the brainstorm server and clean up
# Usage: stop-server.sh <session_dir>
#
# Kills the server process. Only deletes session directory if it's
# under the OS temporary directory (ephemeral). Persistent directories (.superpowers/) are
# kept so mockups can be reviewed later.

SESSION_DIR="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/resolve-system-temp-dir.sh"

if [[ -z "$SESSION_DIR" ]]; then
  echo '{"error": "Usage: stop-server.sh <session_dir>"}'
  exit 1
fi

STATE_DIR="${SESSION_DIR}/state"
PID_FILE="${STATE_DIR}/server.pid"

if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE")

  # Try to stop gracefully, fallback to force if still alive
  kill "$pid" 2>/dev/null || true

  # Wait for graceful shutdown (up to ~2s)
  for i in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  # If still running, escalate to SIGKILL
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true

    # Give SIGKILL a moment to take effect
    sleep 0.1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo '{"status": "failed", "error": "process still running"}'
    exit 1
  fi

  rm -f "$PID_FILE" "${STATE_DIR}/server.log"

  # Удаляем только помеченную сессию непосредственно в системном temp-каталоге.
  if [[ -d "$SESSION_DIR" ]]; then
    SYSTEM_TEMP_DIR="$(resolve_system_temp_dir)" || SYSTEM_TEMP_DIR=""
    TEMP_ROOT=""
    SESSION_REAL=""
    SESSION_PARENT=""
    if [[ -n "$SYSTEM_TEMP_DIR" ]]; then
      TEMP_ROOT="$(cd "$SYSTEM_TEMP_DIR" 2>/dev/null && pwd -P)"
      SESSION_REAL="$(cd "$SESSION_DIR" 2>/dev/null && pwd -P)"
      SESSION_PARENT="$(cd "$(dirname "$SESSION_REAL")" 2>/dev/null && pwd -P)"
    fi
    SESSION_NAME="${SESSION_REAL##*/}"
    EPHEMERAL_MARKER="${SESSION_REAL}/.brainstorm-ephemeral"
    if [[ -n "$SESSION_REAL" && "$SESSION_PARENT" == "$TEMP_ROOT" && "$SESSION_NAME" == brainstorm-* && -f "$EPHEMERAL_MARKER" && ! -L "$EPHEMERAL_MARKER" ]]; then
      rm -rf "$SESSION_REAL"
    fi
  fi

  echo '{"status": "stopped"}'
else
  echo '{"status": "not_running"}'
fi
