#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v codex >/dev/null 2>&1; then
  printf '%s\n' '未找到 Codex CLI；未修改任何配置。' '请在 Codex 桌面应用的插件页添加插件市场：' 'https://github.com/wqy000wqy/codex-debug-mode'
  exit 2
fi
printf '%s\n' "即将通过 Codex 官方命令注册本地插件市场：$repo_dir" '不会安装或升级 Node、npm、Homebrew；不会修改日志或旧版插件。'
config_dir=${CODEX_HOME:-"$HOME/.codex"}
if [ -f "$config_dir/config.toml" ] && [ ! -e "$config_dir/config.toml.before-debug-mode.bak" ]; then
  cp -p "$config_dir/config.toml" "$config_dir/config.toml.before-debug-mode.bak"
  chmod 600 "$config_dir/config.toml.before-debug-mode.bak"
fi
codex plugin marketplace add "$repo_dir"
printf '%s\n' '插件市场已注册。请在桌面插件页找到 Debug Mode 并安装/启用。'
