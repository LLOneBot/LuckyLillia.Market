# LuckyLillia 插件市场的登记仓库。

## 注册插件

1. 必须先将插件发布到 npm。

2. 在本仓库创建「注册插件」Issue，按照 Issue Template 填写 npm 包名等信息。
   截图栏支持多行，每行填写一个包内图片相对路径，路径和顺序与已发布包的 `package.json.llbot.screenshots` 一致（对象项填写 `src`）；留空时自动读取包内声明。

3. 检查通过后，机器人创建包含 `plugins.json` 和 `versions.json` 变更的 PR，等待维护者合并。
如果检查不通过，机器人会在 Issue 下面回复具体不通过问题。


## 插件更新

本仓库 Action 会自动一小时检查一次已注册插件是否有新版本，开发者无需在本 Repo 重新创建 Issue 注册。

## 插件开发

见文档（待施工）
