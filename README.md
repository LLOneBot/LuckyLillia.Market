# LuckyLillia 插件市场的登记仓库。

## 注册插件

1. 必须先将插件发布到 npm。

2. 在本仓库创建「注册插件」Issue，填写 npm 包名，并从下拉框选择插件分类。

3. 检查通过后，机器人创建包含 `plugins.json` 变更的 PR，等待维护者合并。
如果检查不通过，机器人会在 Issue 下面回复具体不通过问题。

未关闭的登记 Issue 收到用户的新评论时，也会触发检查。评论触发会比较 npm `latest` 与该 Issue 上次检查的版本；版本未变就提前结束，不调用 AI、不修改 PR，也不新增 Bot 评论，跳过原因保留在 Actions 日志和报告中。没有历史版本记录时正常检查；Bot 评论、PR 评论和无关 Issue 的评论不会触发登记检查。

发布新版本后可以通过新增评论重新检查。编辑或重新打开 Issue、手动运行或重跑登记工作流仍可检查同一版本，适合修改分类或恢复审查服务后重试。已经登记的插件继续由每小时任务更新。

目录统一保存在 `plugins.json`。每个插件条目包含展示信息和 `version`；`version` 是通过审查的 npm 精确版本号，不能填写 `latest` 或版本范围。新版 Bot 只从条目中读取版本，不再支持旧双文件目录。

注册分类沿用 Bot 的 `PluginCategory`，按以下顺序提供单选：

| 目录中的 `category` | 分类 | 主要用途 |
| --- | --- | --- |
| `protocol` | 协议端 | 登录平台、接入账号和消息源 |
| `adapter` | 适配器 | 对外提供 OneBot、Satori、Milky 等协议 |
| `chat` | 消息互动 | 自动回复、复读、游戏 |
| `tool` | 工具 | 通知、黑名单、独立工具 |
| `service` | 依赖组件 | 为其他插件提供共享服务 |
| `other` | 其他 | 其他用途或未指定分类 |

目录的 `category` 以注册时的选择为准，自动更新版本时保留，也可通过目录 PR 调整。旧 Issue 没有分类栏时，从 npm 发布包的 `llbot.category` 读取，未填写或不认识的值归入 `other`；旧目录条目可以省略 `category`。Bot 安装后的插件列表仍使用包内的 `llbot.category`，建议作者与注册选择保持一致。


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
| Variable（可选） | `MARKET_AI_MAX_OUTPUT_TOKENS` | 每次请求的输出 token 上限，可设置 `1` 到 `131072`，须在模型支持范围内；推理 token 也计入此额度。未配置时首次使用 `32768`，截断重试使用 `65536`；显式配置后，所有尝试都遵守该上限 |
| Secret | `MARKET_AI_API_KEY` | AI 服务的 API Key |

请求地址为基础地址去掉末尾斜杠后追加 `/chat/completions`，例如 `https://ai.example.com/api` 对应 `https://ai.example.com/api/chat/completions`。服务需支持 Chat Completions 和 JSON 输出模式。
若 AI 返回 `finish_reason: length`，工作流会使用同一份完整源码自动重试一次，并要求更简洁的结论；不会使用截断结果放行，也不会删除源码来缩短输入。两次 AI 请求共用 10 分钟的总时限，每次的额度、请求 ID、耗时、结束原因和 token 用量分别保存在 `diagnostics.attempts` 中，`diagnostics.response` 保留最后一次响应信息。
若重试后仍被截断，可以在模型支持范围内提高 `MARKET_AI_MAX_OUTPUT_TOKENS` 或调整审查模型后手动重跑工作流；这属于审查未完成，不代表发现了插件风险。

实际执行登记检查后会新增一条 Issue 评论，只展示登记状态和 AI 审查摘要，并附上该次 Actions 运行及重试记录的链接；提前跳过的评论触发不会新增回复。完整风险项、文件覆盖范围和诊断信息保存在工作流报告中。Actions 日志中的 `[market/register]` 记录版本比较和跳过原因，`[market/review]` 记录和报告中的 `diagnostics` 字段包含检查阶段、模型、输入与输出上限、HTTP 状态、请求 ID、耗时、结束原因、token 用量以及正文和推理内容的字节数，用于排查截断、拒答、接口格式和网络问题。

AI 审查还涵盖 QQ Bot 的违规消息、未经授权的好友和群操作、群管理及账号安全操作。红包、转账、支付、钱包及支付凭据操作至少按中危处理并暂缓登记或更新。

## 市场包发布

`publish.yml` 使用 npm Trusted Publishing（OIDC）发布 `@luckylillia/market`，无需配置 `NPM_TOKEN`。首次启用需要：

1. 包必须已存在于 npm。若尚未发布，在本地使用拥有 `@luckylillia` 发布权限的账号登录并完成首次发布：

   ```sh
   npm login --registry=https://registry.npmjs.org
   npm publish --access public --registry=https://registry.npmjs.org
   ```

2. 在 npm 包的 Settings → Trusted publishing 中添加 GitHub Actions：Organization or user 填 `LuckyLilliaDev`，Repository 填 `LuckyLillia.Market`，Workflow filename 填 `publish.yml`，Environment 留空，并允许 `npm publish`。

3. 手动运行 GitHub Actions 的 `Publish market catalog`。此后目录合并和每小时检查会自动请求发布；内容未变化时跳过发布。

可信发布配置的仓库及工作流名称必须准确匹配，`package.json` 的 `repository.url` 也必须指向当前仓库。缺少可信发布配置时，Action 会报 `ENEEDAUTH`。

## 插件开发

见文档（待施工）
