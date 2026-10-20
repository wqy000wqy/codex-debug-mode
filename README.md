# Debug Mode

在 Codex 中按“提出假设 → 临时埋点 → 用户复现 → 日志分析 → 修复 → 用户确认 → 清理”的流程排查问题。

调试面板默认展开在右侧标签页，提供复现步骤、日志列表与详情、反馈输入、截图附件、继续分析和标记为已修复。界面和工作流说明以中文为主。

这是独立的codex插件，不会给 Codex 增加内置模式；模型通过skill和 MCP 工具执行调试工作流。

## 安装

需要支持本地插件和 MCP Apps 的 Codex 桌面版本，以及可用的 Node.js 22+（或宿主提供的兼容运行时）。当前分发启动器面向 macOS；Linux 尚未验证，Windows 不支持此启动脚本。

在终端注册此 Git 插件市场：

```sh
codex plugin marketplace add wqy000wqy/codex-debug-mode
```

然后在 Codex 桌面的插件页找到 **Debug Mode**，安装并启用。在支持添加 Git 插件市场的界面中，也可以填写本仓库地址：

```text
https://github.com/wqy000wqy/codex-debug-mode
```

安装者不需要运行 npm install 或构建；仓库中的 `plugins/debug-mode/` 已包含打包后的依赖。若原型“调试模式 MVP”仍启用，建议先禁用原型，避免两套技能和工具同时出现。

也可以克隆仓库后运行 `./install-local.command` 注册本地市场。这个脚本只调用 Codex CLI 注册市场；已有配置会先备份，不会安装 Node、npm 或 Homebrew。

## 使用

在新会话中选择 **Debug Mode** 插件并描述实际现象、预期行为和复现条件，例如：

> 有个XXX问题。请用 Debug Mode 提出假设并埋点定位。

1. 模型阅读代码、提出假设并加入临时埋点。
2. 准备完成后，右侧显示调试面板；按步骤在包含埋点的本地应用中复现。
3. 在面板中填写现象或附截图，点击“继续分析”；模型读取该会话的日志继续排查。
4. 修复后按面板步骤再次复现。确认问题解决时，点击“标记为已修复”。模型清理临时埋点和无效实验，保留有效修复与变更；不会因这个按钮额外验证业务或运行测试。

“继续分析”表达本次反馈，不代表复现一定成功。请写明仍失败、现象改变、无法复现等情况。

## 日志与本机服务

MCP 服务名称是 **`debug-mode`**。

每台电脑运行自己的本机接收服务；调试会话和轮次分别管理。接收器只监听回环地址，通过会话标识分流日志，并不把同事的日志上传到本仓库或共享服务器。默认数据目录为 `~/.codex/debug-logs/debug-mode/`（设置 CODEX_HOME 时使用相应目录）。

调试埋点会发送运行时信息。模型应只采集排查所需数据；项目自身的权限、CSP 和浏览器网络限制仍然适用。

## 更新与问题反馈

维护者发布新版本后，在 Codex 的插件市场刷新并更新 Debug Mode；必要时重新打开会话，使工具和技能重新加载。本地克隆安装的用户先执行 `git pull`，再刷新市场。

遇到问题请到 [Issues](https://github.com/wqy000wqy/codex-debug-mode/issues) 提交 Codex 版本、插件版本、系统、复现步骤和错误信息。不要上传凭证、完整业务日志或含私人信息的截图。

安装失败、日志为 0 和维护方法见 [开发与维护说明](docs/DEVELOPMENT.md)。

## 源码与许可

- `src/`：可编辑的运行时、界面和工作流源码。
- `src/workflow.mjs`：技能、工具描述和阶段提示词的统一来源。
- `plugins/debug-mode/`：构建生成并随 Git 提交的可安装插件。
- `.agents/plugins/marketplace.json`：Git 插件市场目录。

采用 [MIT](LICENSE) 许可。打包依赖的许可见 [THIRD_PARTY_NOTICES.md](plugins/debug-mode/THIRD_PARTY_NOTICES.md)。
