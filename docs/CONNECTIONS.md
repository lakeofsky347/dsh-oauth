# 连接、模型能力与真实用量

实现与验证日期：2026-11-16。定义见 `src/catalog.js`，用量适配见 `src/usage/`。本清单描述已实现的读取合同和边界，不代表每个真实账号已验收。

## 凭据和模型来源

网页登录沿用 DSH 授权服务；xAI 保留 PKCE 浏览器登录及设备码备用，Qwen 保留原授权流程。只有宿主实际注册的 OAuth 流程才显示网页登录按钮。

Key 连接保存在宿主 `dsh-oauth-connections/<provider>` 记录中，调用路由引用 `DSH_OAUTH_<PROVIDER>_KEY`，不把 Key 写进 settings。查询授权是独立字段，不写到调用引用。源 CLI 管理的授权只保存来源描述和受控访问令牌镜像，不转移 refresh token 的所有权。

模型快照保存接口声明的能力，未知能力保持未知。宿主当前可表示的能力写入路由，其他能力保留供面板和后续适配使用。不同协议使用对应的 API、base URL 和兼容参数。

## 官方订阅与账号

| 提供商 | 模型来源/接入 | 用量读取 | 额外要求与限制 |
| --- | --- | --- | --- |
| ChatGPT / Codex | 账号目录，宿主 OAuth / Codex 或 OpenCode 来源 | `GET chatgpt.com/backend-api/wham/usage` | 目录请求使用插件支持的客户端版本，或本机 Codex 缓存记录的更新版本。模型列表来自当前授权账号的在线响应，保留 Codex 模型选择器的可见范围 |
| Claude API | Claude Console API Key 的 Anthropic 目录 | Claude Code 套餐用量在官方客户端查看 | API Key 属于 Claude Platform 计费通道 |
| Copilot | 账号 picker/policy 目录 | `GET api.github.com/copilot_internal/user` | 使用原始 GitHub 授权，不使用临时推理 token；只给已用积分而无上限时，不推算余量 |
| Kimi Code | 账号目录、OAuth 或套餐 Key | `/coding/v1/usages` | 中国/国际区明确选择；比例 0–1 转百分比，钱包固定点金额单独换算。普通 Moonshot Key 不等于 Coding Plan |
| MiniMax | 已安装目录加用量响应中明确列出的对话模型，Anthropic 协议套餐通道 | `/v1/token_plan/remains` | 用返回比例核对新旧 counts 语义；`0/0` 不自动当无限。中国推理域名与查询域名可不同 |
| Z.AI / GLM | 优先查询 Coding 通道目录；服务未实现时使用已安装目录 | `/api/monitor/usage/quota/limit` | 组织/项目需成对；TOKENS_LIMIT 不擅自换算成原始 token；工具额度单列 |
| 阿里 Token Plan | 优先查询对应地区的 Token Plan 目录；服务未实现时使用已安装目录 | 个人 Console gateway 读取 | 需要独立 Console token；推理 Key 不自动具有账单权限。本轮不实现团队 ACS3 签名全链路 |
| Grok / xAI | 原有 OAuth 账号目录 | `/v1/billing?format=credits` | 订阅窗口与预付金额分开；已使用本机真实授权通过读取与重启复查，其他套餐仍需分别确认 |
| Nous Portal | 已授权组织推理目录 | `portal.nousresearch.com/api/oauth/account` | Key 连接另需 Portal OAuth；basis points 转百分比；推理 Key 不发送到 Portal 冒充 OAuth |
| Antigravity | 官方 AGY CLI 目录浏览 | `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` | `agy` 通过系统钥匙串管理登入，插件无法从 CLI 直接导入。可在 `agy` 中输入 `/usage` 查看套餐用量。插件查询需要另有匹配的有效来源授权 |
| Gemini CLI | 本轮没有宿主模型协议 | `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | 需要匹配项目和服务资格，不能用已退役的消费者登录路线；个人用户转用 Antigravity |
| Qwen Code 旧 OAuth | 支持读取和移除已有授权 | 不支持主动余量查询 | 新连接使用阿里云套餐入口 |
| DeepSeek API | API 模型目录与 API Key | `GET api.deepseek.com/user/balance` | 保留各币种小数余额，与 DSH 的 DeepSeek 官方网页登录账号分开 |

## 第三方平台

| 平台 | 模型与调用通道 | 用量读取 | 范围与权限 |
| --- | --- | --- | --- |
| OpenRouter | `/api/v1/models/user`，兼容调用 | `/api/v1/key`；可选 `/api/v1/credits` | Key cap、支出、共享预算分别显示；账户 credits 需 Management Key，无法核对身份时保持独立来源 |
| NanoGPT | `/api/subscription/v1/models?detailed=true` 与订阅专用推理通道 | `/api/subscription/v1/usage` | 不把现金余额补作订阅余额；daily/weekly input token、图片各自保留单位 |
| ZenMux | 平台公共目录、兼容调用 | `/api/v1/management/subscription/detail`、`payg/balance` | 需独立 Management 授权；套餐窗口与按量余额分开；公共目录不证明套餐覆盖 |
| OpenCode Go | `/inference/go/v1` | `/zen/go/v1/usage` | 需 workspace/organization ID，调用和查询绑定明确范围 |
| OpenCode Zen | `/inference/v1` | `/console/api/policies/current-budgets` | Console 预算与共享范围单列，需要工作区权限 |
| Kilo | AI Gateway 目录与调用 | 只读 tRPC credit blocks 与 Pass 状态 | 组织显式配置；微美元按 1e6 换算；续订不等于所有余额同时重置 |
| Poe | `/v1/models` 与兼容调用 | `/usage/current_balance` | 点数余额；接口不给重置时间就不补；公共 bot/模型目录不证明套餐权益 |
| Synthetic | `/openai/v1` | `/v2/quotas` | remainingPercent 与部分恢复分开；nextRegenAt 不是全量刷新 |
| Chutes | `llm.chutes.ai/v1` | `api.chutes.ai/users/me/subscription_usage` | 订阅窗口与月度额度；本轮不逐模型遍历全部请求池 |
| New API | 明确配置的 HTTPS API 根地址 | 实例 origin 的 `/api/usage/token/` | 仅支持该合同的部署；保留实例配额单位，不假定等于美元；未接用户级订阅账单 |

## 保存与并发语义

- 新配置默认 `expiresAt: null`，旧数值到期配置继续按原期限处理。清理只恢复仍等于插件写入值的字段。
- 模型文件保留完整能力与路由归属；用量文件保留来源、观察时间和身份指纹，不包含令牌。
- profile JSON 采用同进程排队、跨进程锁、原子替换和 `0600` 权限；损坏文件不会被空对象覆盖。
- 凭据提交与读取走宿主原子记录接口；账号替换前清理旧路由，旧查询不会显示成新连接的额度。
- 本机来源使用前重读并核对连接版本；源退出后使自己的镜像失效，保留别处新写入的网页登录授权。
- 每个 provider 在面板中只有一个当前连接，没有实现同厂商多账号池或自动轮换账号。

## 查询状态与缓存

| 状态 | 含义 |
| --- | --- |
| `fresh` | 获得可识别的提供商结果，仍应查看观察时间 |
| `partial` | 有部分真实数据，其他字段/权限缺失；不填零 |
| `stale` | 临时失败时保留旧观察及旧时间，不是当前实时余额 |
| `needs-permission` | 缺查询权限或管理授权 |
| `needs-configuration` | 缺项目、工作区或必要范围 |
| `reauth-required` | 授权不可用，或源 CLI 需要续期 |
| `rate-limited` | 查询接口限流，不代表订阅额度耗尽 |
| `unsupported` | 没有已实现的读取方式 |
| `unavailable` | 网络、服务或未知响应不可用 |

普通缓存 60 秒、强制刷新至少间隔 5 秒，服务端 Retry-After 优先；同一连接并发查询合并。缓存绑定凭据、连接版本和范围，换号后不复用。401/403 不显示旧余额，未知返回结构按错误处理。

读取使用固定供应商域名、超时、响应大小上限并拒绝重定向。New API 只使用明确配置且通过校验的实例地址。错误不回显任意供应商响应正文或令牌片段。

## 参考与未完成范围

设计参考 [OpenCode](https://github.com/anomalyco/opencode) 的授权与模型接入、[Hermes Agent](https://github.com/NousResearch/hermes-agent) 的能力与套餐状态。字段优先核对供应商合同，包括 [OpenRouter credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)、[DeepSeek 余额](https://api-docs.deepseek.com/api/get-user-balance) 和 [Google 服务迁移说明](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)。

尚未完成：Hermes 本机凭据、Google 模型调用协议、阿里团队 ACS3 账单、New API 用户级订阅账单、LiteLLM 专用管理适配，以及其余供应商真实账号的逐家验收。Codex、OpenRouter、xAI 的真实只读验收已通过，见 [验收记录](LIVE-VALIDATION-1.0.1.md)。接口或服务资格变更仍需重新核对。
