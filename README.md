# dsh-oauth

DeepSeek Harness 的 OAuth 登录面板。用已订阅的账号登录，并把该账号实际返回的模型写入当前配置。

Sign in with a subscribed account and pull that account's models into DeepSeek Harness.

适配 DeepSeek Harness 0.1.7 这一线（`>=0.1.7-rc.1 <0.1.8-0`），网页 profile 和官方桌面版都使用这份插件。

## 安装

在目标 profile 中加入本仓库：

```sh
dsh plugin --profile oauth add /path/to/dsh-oauth
dsh --profile oauth --port 3081
```

官方桌面版使用 `desktop` profile，命令行不能直接管理它。把 `dsh-oauth` 写进 `~/.dsh/profiles/desktop/package.json` 的依赖和 `dsh.profile.bundles`，然后重新打开桌面版。设置里的 OAuth 页，或本机 `http://127.0.0.1:19387/oauth/`，就是这块面板。

## 使用

1. 打开 OAuth 页，选择账号并登录。浏览器会打开该账号自己的认证页。
2. 登录完成后拉取模型。列表只来自这次登录的账号。勾选要用于对话的模型，并设置过期时间。
3. 到期后，这条模型路由会从设置里去掉。
4. 生图和生视频留在当前对话中完成，不会把正在使用的对话模型换成图像或视频模型。

DeepSeek 官方账号在当前组合已经提供登录时会出现在列表里，登录后直接使用，不另拉一份模型目录。通义千问登录后，拉取到的对话模型写入 `qwen` 路由。

## 账号

- ChatGPT / Codex
- Claude
- Grok
- GitHub Copilot
- Kimi Code
- OpenRouter
- 通义千问
- DeepSeek 官方账号
