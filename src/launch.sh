#!/bin/sh
# No downloads, dependency installation, or persistent configuration writes.
set -eu
runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
run_node() {
  candidate=$1
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    if "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
      exec "$candidate" "$runtime_dir/server.mjs"
    fi
  fi
}
# A user-selected runtime is authoritative: do not silently select another one.
if [ -n "${CODEX_DEBUG_NODE_PATH:-}" ]; then
  run_node "$CODEX_DEBUG_NODE_PATH"
  echo 'Debug Mode: CODEX_DEBUG_NODE_PATH must point to an executable Node.js 22+.' >&2
  exit 1
fi
run_node "${CODEX_MCP_NODE_PATH:-}"
run_node "$(command -v node 2>/dev/null || true)"
run_node /opt/homebrew/bin/node
run_node /usr/local/bin/node
echo 'Debug Mode needs Node.js 22+. Make node available on PATH or set CODEX_DEBUG_NODE_PATH. Nothing was installed automatically.' >&2
exit 1
