# 插件发现与社区收录

DSH 的发现页使用插件索引，宿主不预置统一来源。可在实验性插件中启用 Custom plugin indexes，然后在 Discover 添加维护者源：

```
https://raw.githubusercontent.com/qiuYliangM/dsh-codex-bridge/main/market/index.json
```

索引使用 DSH format 1，安装来源固定为已审核的 Git 提交，不会自动安装或替换现有插件。选择版本后仍走宿主的正常确认和兼容检查。说明见 [DSH 官方索引文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md)。

维护者源是本项目自行发布的索引，不表示被官方或社区推荐。社区 dsh-market 读取 awesome-dsh-plugin 目录；收录申请按其 [贡献规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 提交，仓库必须创建满一天并由维护者审核。提交或 CI 通过不代表已合并上架。npm 发布不是收录前提，本项目未发布到 npm。
