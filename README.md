# DSH Codex Bridge

只在 **DeepSeek Harness 安装一次**的标准插件，连接本机 Codex 与 DSH，提供双向消息、工程和会话管理。启用时自动登记 Codex HTTP MCP，使用宿主运行时；无需第二个应用、常驻 Hub、全局 Node.js 或手工复制网关 token。

独立项目来自 [Codex DeepSeek Bridge](https://github.com/qiuYliangM/codex-deepseek-bridge) 的插件分支。当前版本 **0.5.2**，包名继续使用 `peerbridge-dsh-plugin`，便于原插件升级；旧系统安装器不包含在本项目中。

## 安装

需要两个客户端安装在同一台机器、同一 OS 用户下，且 Codex CLI 可用。兼容 DSH `>=0.2.2-rc.4 <0.3.0-0`、Node.js 22.19+ 的宿主。其他宿主版本会由安装器检查兼容性，不建议强制跳过。

```sh
dsh plugin --profile desktop add github:qiuYliangM/dsh-codex-bridge#v0.5.2
```

Web 版把 `desktop` 改成 `web`。此仓库根目录就是可安装的 bundle，没有安装期构建脚本。首次启用后重载 Codex 工具；宿主提示需要重启时重启 DSH。安装过程不发送模型消息。

也可下载 [发布包](https://github.com/qiuYliangM/dsh-codex-bridge/releases)。DSH Desktop 0.31.7 启动时会误清理本地 `.tgz` 依赖，请先解压到长期保留的目录，再通过插件页或 CLI 安装目录：

```sh
mkdir -p ~/.local/share/dsh-codex-bridge/0.5.2
tar -xzf /path/to/peerbridge-dsh-plugin-0.5.2.tgz --strip-components=1 -C ~/.local/share/dsh-codex-bridge/0.5.2
dsh plugin --profile desktop add ~/.local/share/dsh-codex-bridge/0.5.2
```

保留该目录，升级使用新版本目录。不要同时启用旧 stdio 桥与新 bundle；旧安装器拥有的标记 patch 会迁移。源代码和发布包均不包含两个客户端或账户凭据。

在 DSH 发现页添加维护者插件源的方法，以及社区收录状态说明，见 [插件中心](docs/market.md)。

## 使用

两端均提供 12 个 `peer_*` 工具，`peer` 指对方客户端。已知目标时直接传入精确工程和会话：

```json
{"workspace":"对方 workspaceId 或精确绝对路径","session":"该工程下的 sessionId","text":"请检查当前工程"}
```

`peer_send`、`peer_ask` 必须同时提供工程和会话。目标不存在、已归档或会话不属于该工程时返回错误；用查询/创建工具自行处理，不猜测默认目标或自动创建。

| 工具 | 用途 |
| --- | --- |
| `peer_status` | 查看连接与能力 |
| `peer_workspaces` / `peer_create_workspace` / `peer_rename_workspace` | 列出、新建、改名工程 |
| `peer_sessions` / `peer_create_session` / `peer_rename_session` / `peer_archive_session` | 列出、新建、改名、归档或恢复会话 |
| `peer_send` | 将消息排队；回执不代表模型已完成任务 |
| `peer_ask` / `peer_answer` | 有超时、取消和问题 ID 关联的问答 |
| `peer_events` | 查看共享时间线 |

原生 Codex MCP 每次请求的 `_meta.threadId` 和 DSH 工具执行上下文自动提供来源会话。手填 `sourceSession` 与宿主来源冲突会报错。HTTP MCP 的连接会话 ID 不用于识别聊天。来源标签不是身份认证；返回目标仍需显式传入，结构化收件箱与 `peer_reply` 尚未实现。

新工程不会生成代码或发开场消息。Codex 桌面登记通过现有目录入口，可能选中工程并需要用户信任；不修改客户端二进制或状态文件。后台登记和桌面名称同步分开报告，未完成时不会声称成功。详情见 [运行边界](docs/behavior.md)。

## 配置与共存

在 DSH 的 `codex-deepseek-bridge` 插件配置中设置：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `autoConfigureCodex` | `true` | 自动登记自己的 Codex MCP |
| `mcpServerName` | `peerbridge` | Codex 中的 MCP 名称与路由路径 |
| `codexBin` | 自动检测 | 可用的 Codex 可执行文件 |
| `codexHome` | 环境变量或 `~/.codex` | 目标 Codex 配置目录 |

多个 DSH profile 共存时分别设置不同的 `mcpServerName`。同一 profile 的 `peer_*` 工具只能有一组；发现同名外部工具时应停用冲突插件，桥会拒绝覆盖。插件只操作自己拥有的 Codex 配置，保留其他 MCP 和用户策略。

本插件需要宿主的 `tools`、`webServer`、`connection`、`profileContext` 与 `loader` 服务，支持本机回环 HTTP；无 Web 服务的 headless/SDK profile、远程监听和 TLS 入口暂不支持。

## 卸载

通过 DSH 插件页停用或移除，按宿主提示重启。正常停用清理工具、路由与自己拥有的自动登记 Codex MCP。手动模式（`autoConfigureCodex: false`）只释放自己的活跃标记，不修改用户手工配置。离线卸载、强制退出可能留下失效注册，提供只检查和显式清理的命令：

```sh
node scripts/cleanup.mjs
node scripts/cleanup.mjs --apply --profile-dir /absolute/path/to/dsh/profiles/desktop
```

详见 [残余清理](docs/uninstall.md)。共享历史、索引、旧备份和下载目录默认保留，不会删除聊天工程或其他插件的数据。

## 开发与验证

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm test
npm run package
npm run test:package
```

测试使用隔离目录和模拟客户端；默认不访问日常聊天，不发送模型消息。可用 `PEERBRIDGE_TEST_CODEX_BIN=/path/to/codex npm test` 验证真实 Codex 配置和元数据。完整隔离 DSH 安装/停用/重装/卸载验证见 [测试说明](docs/testing.md)。

产物 `dist/peerbridge-dsh-plugin-0.5.2.tgz` 与 `PLUGIN-SHA256SUMS`。运行时代码在 `src/`，依赖的 `ws` 源码和 MIT 许可证位于 `vendor/`。

[MIT](LICENSE) · [安全边界](SECURITY.md) · [审核记录](docs/review.md)
