# @lks347/dsh-oauth 1.0.2

- Codex 使用更新的模型目录协议版本。OpenRouter 跟随同源分页，Copilot 保留标记缺失但策略明确启用的模型，Grok 保留目录中可导入的媒体变体。
- OpenCode v2 通过官方 CLI 读取可用凭证元数据，并按需获取选定提供商的授权。继续支持 v1 的 `auth.json`。授权失效时，面板会提示回到源 CLI 处理。
- Claude 面板支持 Console API Key。历史 Qwen OAuth 授权可继续使用，新连接使用阿里云套餐入口。Gemini CLI 个人用户可在 Antigravity CLI 登录，AGY 条目可通过官方 CLI 读取模型目录。
- 修复 Kimi OAuth 适配器只返回授权请求头时无法拉取目录的问题。阿里云 Token Plan 和 Z.AI 优先查询套餐端点的目录，MiniMax 补充用量端点明确列出的对话模型。服务未提供目录时展示已安装目录及其来源。

AGY 订阅登录由 CLI 的系统钥匙串管理，可在官方 CLI 中使用模型并通过 `/usage` 查看套餐用量。插件的 AGY 浏览页用于查看目录。OpenCode v2 如有多个账户且 CLI 响应无法明确标识所选账户，插件会提示选择可无歧义复用的授权。桌面宿主找不到 OpenCode 时，可为宿主设置 `DSH_OAUTH_OPENCODE_BIN`，值为 OpenCode 可执行文件的绝对路径。
