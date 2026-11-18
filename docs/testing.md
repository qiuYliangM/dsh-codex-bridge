# 验证

常规测试使用临时目录、模拟网关与假客户端，不访问日常聊天。

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm test
npm run package
npm run test:package
```

CI 检查 Linux Node.js 22.19/24、Windows、macOS Intel 与 ARM。测试通过表示这些隔离场景通过，不代表所有客户端版本的 GUI 均已实测。

可选真实 Codex 验证不发送模型消息，使用独立 CODEX_HOME：

```sh
PEERBRIDGE_TEST_CODEX_BIN=/path/to/codex npm test
```

可选完整宿主生命周期验收：

```sh
PEERBRIDGE_TEST_DSH_SHIM=/path/to/dsh \
PEERBRIDGE_TEST_CODEX_BIN=/path/to/codex \
node verify/live-dsh-plugin.mjs
```

需要官方桌面生成的 dsh shim 或可执行 CLI。脚本为固定 DSH_HOME 的桌面 shim 制作测试副本，安装前检查 home 隔离，不修改用户 shim。其余 CLI 路径参数及可能的本地 pnpm 复用见脚本注释。验收创建独立 DSH_HOME、CODEX_HOME 和 PEERBRIDGE_HOME，验证安装、工具发现、网关读取、停用清理、重新启用、重启恢复、重复安装与卸载，再执行离线清理核验私密注册文件已移除。安装依赖可能需要网络。

真实模型双向聊天属于另外的人工授权验收；`peer_send` 入队本身不能作为对方已处理的证据。应分别核对接收端持久化记录、模型实际工具回传和原聊天最终接收。
