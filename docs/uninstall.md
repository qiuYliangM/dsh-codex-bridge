# 停用、卸载与残余清理

先在 DSH 插件页停用或移除 **peerbridge-dsh-plugin**。需要重启时按宿主提示操作。插件运行期间通过宿主注销自己的 12 个工具与 HTTP 路由，并用 Codex 的配置接口撤销自己拥有的 MCP 连接。手动模式（`autoConfigureCodex: false`）停用时只释放活跃标记，不修改用户手工设置；之后可显式检查、清理属于桥的失效接入口。旧 Codex 聊天可能在重载前继续显示工具名称，失效端点不能再处理调用。

宿主已关闭时卸载包，或进程被强制终止，无法执行插件的生命周期回调。这种情况下可保留插件源码或解压后的发布包，运行离线检查：

```sh
node scripts/cleanup.mjs
```

默认只检查，不删除注册或修改 MCP 配置。输出不包含 token。确认相关 DSH profile 已停用/卸载，使用 `--apply` 撤销遗留 MCP 并删除对应的私密注册记录：

```sh
node scripts/cleanup.mjs --apply --profile-dir /absolute/path/to/dsh/profiles/desktop
```

自定义 `CODEX_HOME` 或 MCP 名称时，可用 `--codex-home /path` 和 `--server-name name` 指定。`--directory` 指定桥的数据目录，默认 `PEERBRIDGE_HOME` 或 `~/.peerbridge`。`--codex-bin` 指定可用的 Codex 可执行文件。需要 Node.js 22.19+；也可使用 DSH 自带的 Node 可执行文件运行脚本。

清理拒绝活动的注册，保留用户改过目标或凭据的 MCP，且不会覆盖其他同名外部连接。无法访问 Codex 配置时保留恢复记录并返回失败，修复路径后可重试。注册文件只按可验证的所有权清理，不按名称猜测。也会检查本注册精确 UUID 前缀的崩溃暂存文件；可证明已不活跃且归属匹配的文件可清理，活跃或无法确认归属的文件会保留并报告。存在保留项时命令返回非零状态，不会声称清理完成。

`~/.peerbridge/timeline.jsonl`、`config.json`、会话索引、旧安装快照和用户下载/解压的插件目录可能供其他 profile 或旧版本使用，默认保留。历史消息含私人内容，应按自己的保留需求管理。确认所有版本与 profile 都已卸载、不需要历史后，可自行删除该数据目录和下载目录；不要把整个 `~/.codex` 或 `~/.dsh` 当作本插件残余删除。

本插件没有系统服务、开机启动项或系统级安装包。DSH 的依赖缓存和禁用配置由宿主包管理器管理；插件不修改其他插件的依赖、配置、工具或文件。
