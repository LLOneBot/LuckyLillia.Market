# LuckyLillia 插件市场的登记仓库。

## 注册插件

1. 必须先将插件发布到 npm。

2. 在本仓库创建「注册插件」Issue，按照 Issue Template 填写 npm 包名等信息。

3. 检查通过后，机器人创建包含 `plugins.json` 和 `versions.json` 变更的 PR，等待维护者合并。
如果检查不通过，机器人会在 Issue 下面回复具体不通过问题。


## 插件更新

本仓库 Action 会自动一小时检查一次已注册插件是否有新版本，开发者无需在本 Repo 重新创建 Issue 注册。

## 仓库配置

插件登记、目录 PR 中新增或变更的插件以及自动版本更新都必须通过 AI 审查。缺少配置、审查失败或未通过时，登记或更新会暂缓。

在仓库 Settings → Secrets and variables → Actions 中配置：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Variable | `MARKET_AI_BASE_URL` | HTTPS 接口基础地址，可带自定义路径 |
| Variable | `MARKET_AI_MODEL` | 服务支持的模型 ID |
| Variable（可选） | `MARKET_AI_MAX_INPUT_BYTES` | 审查输入的字节数上限，默认 `524288`，最大 `8388608` |
| Secret | `MARKET_AI_API_KEY` | AI 服务的 API Key |

请求地址为基础地址去掉末尾斜杠后追加 `/chat/completions`，例如 `https://ai.example.com/api` 对应 `https://ai.example.com/api/chat/completions`。服务需支持 Chat Completions 和 JSON 输出模式。

每次登记运行都会新增一条 Issue 评论，并附上该次 Actions 运行及重试记录的链接。Actions 日志中的 `[market/review]` 记录和报告中的 `diagnostics` 字段包含检查阶段、模型、输入与输出上限、HTTP 状态、请求 ID、耗时、结束原因、token 用量以及正文和推理内容的字节数，用于排查截断、拒答、接口格式和网络问题。

AI 审查还涵盖 QQ Bot 的违规消息、未经授权的好友和群操作、群管理及账号安全操作。红包、转账、支付、钱包及支付凭据操作至少按中危处理并暂缓登记或更新。

## 插件开发

见文档（待施工）
