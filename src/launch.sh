#!/bin/sh
# No downloads, dependency installation, or persistent configuration writes.
set -eu
runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
selected_node=
select_node() {
  candidate=$1
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    if "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
      selected_node=$candidate
      return 0
    fi
  fi
  return 1
}
home_dir=${HOME:-}
# A user-selected runtime is authoritative: do not silently select another one.
if [ -n "${CODEX_DEBUG_NODE_PATH:-}" ]; then
  if ! select_node "$CODEX_DEBUG_NODE_PATH"; then
    echo 'Debug Mode: CODEX_DEBUG_NODE_PATH must be an absolute path to an executable Node.js 22+.' >&2
    exit 1
  fi
else
  path_node=$(command -v node 2>/dev/null || true)
  for candidate in \
    "$path_node" \
    "$home_dir"/.volta/bin/node \
    "$home_dir"/.nvmd/versions/*/bin/node \
    "$home_dir"/.nvm/versions/node/*/bin/node \
    "$home_dir"/.fnm/node-versions/*/installation/bin/node \
    "$home_dir"/Library/Application\ Support/fnm/node-versions/*/installation/bin/node \
    "$home_dir"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$home_dir"/.local/share/mise/installs/node/*/bin/node \
    "$home_dir"/.mise/installs/node/*/bin/node \
    "$home_dir"/.asdf/installs/nodejs/*/bin/node \
    /opt/homebrew/bin/node \
    /opt/homebrew/opt/node@22/bin/node \
    /usr/local/bin/node \
    /usr/local/opt/node@22/bin/node \
    /opt/local/bin/node
  do
    if select_node "$candidate"; then break; fi
  done
fi
if [ -z "$selected_node" ]; then
  if [ "${1:-}" = "--check" ]; then
    echo '未找到可启动 Debug Mode 的 Node.js 22+。已检查 PATH、nvmd、nvm、fnm、Volta、mise、asdf，以及常见 macOS Homebrew/MacPorts 路径。' >&2
    echo '请安装 Node.js 22+，或将 CODEX_DEBUG_NODE_PATH 设为 node 的绝对路径后重新启动 Codex。启动器不会自行下载或安装运行时。' >&2
  else
    echo 'Debug Mode MCP 启动失败：没有找到 Node.js 22+。已检查 PATH、nvmd、nvm、fnm、Volta、mise、asdf，以及常见 macOS Homebrew/MacPorts 路径。' >&2
    echo '请安装 Node.js 22+，或将 CODEX_DEBUG_NODE_PATH 设为 node 的绝对路径后重新启动 Codex。' >&2
  fi
  exit 1
fi
if [ "${1:-}" = "--check" ]; then
  printf 'Debug Mode runtime OK: %s (%s)\n' "$selected_node" "$("$selected_node" --version)"
  exit 0
fi
exec "$selected_node" "$runtime_dir/server.mjs"
