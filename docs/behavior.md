# 工程、会话和消息的运行边界

## 目标参数

已知目标时，直接调用：

```json
{
  "workspace": "对方工具返回的 workspaceId，或精确绝对路径",
  "session": "该工程下的 sessionId",
  "text": "消息内容"
}
```

`peer_send` 和 `peer_ask` 必须同时指定 `workspace`、`session`。桥在发送前校验工程存在、会话存在且未归档，以及会话确实属于指定工程。缺少参数、不存在、路径歧义或工程与会话不匹配时直接报错，不选默认目标，不自动新建。

调用方拿到错误后自行决定下一步：用 `peer_workspaces` 查询或 `peer_create_workspace` 新建工程；用 `peer_sessions({workspace})` 查询或 `peer_create_session({workspace})` 新建会话。创建操作只返回 ID，后续调用继续显式传入目标，不发送开场消息。

MCP 的目标错误（旧项目消息 CLI 亦然）包含 `code`、`message`、`details` 和 `nextTools`，例如：

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "会话不存在或已归档，请调用 peer_sessions 查询，或 peer_create_session 新建",
    "details": {"workspaceId": "...", "sessionId": "...", "archived": false},
    "nextTools": ["peer_sessions", "peer_create_session"]
  }
}
```

旧的 `peer_select_workspace`、`peer_select_session`、`peer_clear_selection` 和 `bind` 已停用；旧选择文件和配置中的 `codexThread` 不再参与路由。历史数据保留，不自动删除。

## 工具

两端提供相同的 12 个工具，`peer` 始终代表对方客户端。这些工具不是任意桌面操作接口：

| 工具 | 必需目标参数 | 操作 |
| --- | --- | --- |
| `peer_status` | 无 | 查看连接和能力 |
| `peer_workspaces` | 无 | 列出真实注册的工程，包括空工程 |
| `peer_create_workspace` | `path` | 登记本机目录；目录不存在时须显式指定 `createDirectory: true` |
| `peer_rename_workspace` | `workspace` | 修改后台工程名，保留目录路径；Codex 桌面名称未同步时返回未完成 |
| `peer_sessions` | `workspace` | 列出工程会话；`archived: true` 查看归档 |
| `peer_create_session` | `workspace` | 创建空会话，返回其 ID；Codex 单独报告原生列表与界面核验状态 |
| `peer_rename_session` | `workspace`、`session` | 修改会话名称 |
| `peer_archive_session` | `workspace`、`session` | `archived: true/false` 归档或恢复，保留历史和文件 |
| `peer_send` | `workspace`、`session` | 消息入队，回执不代表任务已完成 |
| `peer_ask` | `workspace`、`session` | 提问并等待，支持取消和超时 |
| `peer_answer` | `questionId` | 回答问题，按问题 ID 关联 |
| `peer_events` | 无 | 查看共享时间线，最多 200 条 |

创建已注册目录返回原工程，不重复创建，也不覆盖现有名称。不会克隆仓库、生成项目代码或删除目录。Codex 本机桌面版的新建操作会通过工程入口打开目录，因此会选中该工程并显示空白输入页，但不创建会话、不发送消息。

Codex 本机桌面同步：检测到本机桌面版后，新目录通过 `codex://new?path=…` 入口登记，等待桌面持久化记录中的工程 ID，再通过后台 `project/read` 核对目录。不会先另建一个后台工程，从而避免重复。当前 Linux 安装路径自动识别；其他安装路径可在 `~/.peerbridge/config.json` 指定 `codexDesktopBin`，设为 `false` 则仅使用后台接口。独立 `CODEX_HOME` 或远程 `codexSocket` 不自动启动本机桌面。目录信任需要用户在客户端处理；超时后应先查询已有结果。

`desktopSync` 分别报告 `registered`（桌面状态中已登记）、`missing`、`identity-mismatch` 或 `unavailable`，并通过 `displayTitle`、`titleMatches` 区分后台名称与桌面名称。`liveUiVerified: false` 表示运行时仅核对持久化登记，没有读取屏幕。桌面入口使用目录名；请求不同的自定义标题会返回 `titleApplied: false`、`completed: false`，不能报告完整成功。已有的仅后台登记工程不会自动合并或重复新建，会保留原 ID 并返回 `completed: false`；未检测到桌面入口时也明确返回后台部分成功。修改后台工程名暂不保证同步桌面名称。读取桌面状态不修改客户端文件、不自动重启客户端。DeepSeek 官方桌面版的创建结果已验证进入其工作区注册表。

Codex 的原生 MCP 调用通过每次请求的 `_meta.threadId` 自动提供来源会话；DSH 使用执行工具的 Agent 会话 ID。宿主提供来源时，手工 `sourceSession` 与其冲突会报 `SOURCE_SESSION_MISMATCH`，不会发送。旧项目的 stdio 兼容入口保留环境变量回退（本仓库不提供该入口）；缺少宿主上下文的兼容调用仍可显式提供来源标签。MCP 的连接会话 ID 不用于识别 Codex 聊天，来源缺失时也不猜测默认聊天。来源字段不决定发送目标。

这只补齐自动来源识别；结构化收件箱和 `peer_reply` 尚未实现，当前消息来源仍显示在正文标签中。原生元数据是宿主提供的调用上下文，不构成跨用户身份认证。

## 实现与边界

- Codex → DSH：调用插件内的鉴权 HTTP MCP；插件使用宿主当前网关凭据执行工程和会话操作，WebSocket `workspace/follow` 获取注册表快照，`session/prompt` 入队。
- DSH → Codex：按需运行 `codex app-server --listen stdio://`，调用 `project/*`、`thread/*`；消息使用 `codex queue`。入队成功后，匹配本机桌面时通过 `codex://threads/wake/<id>` 请求后台恢复目标会话，不添加第二条消息、不切换当前聊天。该入口依赖客户端版本；请求成功只表示进程入口受理，`desktopActivation.confirmed` 仍为 `false`。没有匹配入口或请求失败时保留原入队 ID 和警告，不应重发。配置 `codexSocket` 可改用已运行 daemon 的 `app-server proxy`。
- Codex 项目管理依赖本机实验性 app-server 协议；旧版本缺少接口会返回错误。
- Codex 默认列表隐藏新建空会话。桥保留自己创建的会话 ID，并通过 `thread/read` 验证和补全列表；归档以服务器列表为准。这个索引用于列出会话，不是默认发送目标，也不被 Codex 侧栏读取。创建返回 `created: true`、`backendCreated: true`、`completed: false`；`session.desktopSync.nativeListVisible` 为原生列表核验结果（失败为 `null`），`state` 为 `listed`、`not-listed` 或 `unverified`。`liveUiVerified: false` 明确没有读取屏幕，`listed` 也不能当作当前窗口已经显示。匹配本机桌面时 `openUrl` 可打开已有会话；创建本身不自动导航、不制造开场消息。发送后请求后台唤起，由客户端消费队列后形成实际聊天历史。
- DSH 网关仅支持本机回环地址。目录创建、回答文件共享和两个客户端须处于同一用户文件系统中。
- 创建与改名分步执行；若创建后改名失败，错误包含已创建对象 ID，避免重复创建。
- 问答依赖当前进程等待和本地短期问题状态；成功、取消、超时及发送失败均清理该问题目录。崩溃遗留在最多 900 秒有效期后由下次调用或启动回收；进程重启后的任务恢复、跨主机传输、自动循环对话终止策略尚未实现。避免双方同时阻塞等待对方回答。
- `peer_send` 的 DSH `requestId` 可由调用者提供以重试同一逻辑消息；Codex queue 暂无对应去重保证。回执仅表示排队。
- `~/.peerbridge/`（或 `PEERBRIDGE_HOME`）保存配置、旧安装快照、已创建 Codex 会话索引、时间线和短期问题状态，均为本机明文文件。
- 本项目只发布标准 DSH bundle；旧系统打包脚本不在本仓库。
