# dsh-oauth

DeepSeek Harness 的 OAuth 认证管理面板。插件版本 0.1.7，适配 DeepSeek Harness 0.1.7-rc.1（`dsh-v0.1.7-rc.1`）。`@deepseek-ai/dsh`、`dsh-authorization`、`dsh-credentials`、`dsh-tools` 的 peer 都锁在 `0.1.7-rc.1`，启动时的版本检查会按这个范围放行。0.1.7 的基础组合已经挂上 authorization；这个插件只在当前组合里没有该服务时才自己挂上。

自定义接口在 `theme.js` 的 `window.DshOAuth`：

```js
DshOAuth.applyTheme({ accent: "#679efe", radius: "16px" })
DshOAuth.setLoginOpener((provider) => window.open(provider.docs))
DshOAuth.onAuthorize(async (provider) => true)
DshOAuth.registerProvider({ id: "my-provider", name: "My Provider" })
```

`applyTheme` 写成 `--dsh-oauth-*` 变量，面板和认证弹窗一起吃这套值。`onAuthorize` 返回 `false` 时，认证页点了授权也不会写成已连接。

- 一张卡片列出全部订阅提供商，标题右侧是已连接数量和刷新
- 每一行是状态图标、名称、流程徽标、过期时间、token 预览
- 未连接时给出备用命令，并可复制
- 「登录」直接弹出该提供商的认证页（`auth.html`）。认证页上授权或取消，结果回到面板。面板不展示、也不要求粘贴授权码。
- 「断开连接」先确认，再删掉本机记录

登录只保存 OAuth grant，不把适配器的默认模型目录写进路由。已连接的提供商用「拉取模型」向该 OAuth 账号请求模型列表。xAI 的对话模型来自订阅目录，包含 `grok-4.7-build-fast`；勾选的对话模型写入 `llm-pi-ai` 的 `models`。生图和生视频使用该账号当前的图像、视频模型，调用留在当前对话里，不切换会话所选的对话模型。过期时间用日期时间自己定，也可以用 1 小时到 30 天的快捷项填上再改。到期后这条路由会从模型设置里拿掉，避免退回适配器默认目录。

官方桌面版安装包 `deepseek-harness-0.1.7-rc.1.20260924.1` 的运行时是 `@deepseek-ai/dsh-app-boot` 0.1.7-rc.1，和上面的 peer 一致。桌面版使用 profile `desktop`，本机页面在 `127.0.0.1:19387`。命令行不能管理这个 profile，依赖写在 `~/.dsh/profiles/desktop/package.json`。

订阅 OAuth 来自当前 dsh 已注册的登录（ChatGPT / Codex、Claude、Grok、GitHub Copilot、Kimi Code、OpenRouter）。另外两项是本插件自己接上的：通义千问走 chat.qwen.ai 的设备码登录，拉到的模型写进 `qwen` 路由；DeepSeek 官方账号走桌面版已有的浏览器登录，不另拉一份模型目录。

单独用命令行时，插件也可以装在 profile `oauth`：

```sh
dsh --profile oauth --port 3081
```
