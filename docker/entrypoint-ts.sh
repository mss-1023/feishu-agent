#!/bin/bash
set -e

mkdir -p /root/.config/ai-container

mkdir -p "${CLAUDE_WORK_DIR:-/workspace}/feishu_sessions_ts"
mkdir -p "${UPLOAD_DIR:-/workspace/uploads}"

if [ -f "${HOST_PATH_ALLOWLIST_FILE:-/root/.config/ai-container/mount-allowlist.json}" ]; then
    echo "[init] Runtime allowlist file detected: ${HOST_PATH_ALLOWLIST_FILE:-/root/.config/ai-container/mount-allowlist.json}"
fi

echo "[init] Ready. Starting: $*"
exec "$@"
