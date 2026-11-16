# dsh-oauth

[English](README.en.md)

为 DeepSeek Harness 接入订阅账号和第三方模型平台：保存授权，导入模型及能力，查询提供商返回的真实套餐用量、额度和余额。页面保留原来的侧栏、提供商列表和弹窗结构，支持中文与英文。

当前包名与版本为 **`@lks347/dsh-oauth@1.0.1`**。2026-11-16 已通过 DSH **0.2.0-rc.2 / pi-ai 0.87.1** 与 **0.2.2-rc.3 / pi-ai 1.5.2** 的离线宿主集成验证，并使用本机已有的 **Codex、OpenRouter、xAI 授权**通过真实模型导入、独立进程重启恢复和用量查询。其他平台仍以合同样例测试为主，不代表所有套餐和地区均已实测。

## 安装到目标 profile

使用目标 DSH 安装附带的 CLI：

```sh
dsh plugin --profile oauth add /absolute/path/to/dsh-oauth
dsh --profile oauth --port 3081
```

打开该实例的 `/oauth/`，或设置中的 OAuth 页面。官方桌面组合通常使用 `desktop` profile；可在插件管理器中加入本地包。修改仓库不会自动更新已经安装的插件，安装后按宿主提示重新加载。

如需生成本地安装包：

```sh
npm pack
dsh plugin --profile desktop add /absolute/path/to/lks347-dsh-oauth-1.0.1.tgz --offline
```

`npm pack` 生成本地安装包；npm 发布状态见 [1.0.1 发布说明](docs/RELEASE-1.0.1.md)。请使用作用域包名，非作用域的 `dsh-oauth` 不属于本仓库当前发布账号。

## 连接、导入与查询

1. 选择提供商，通过宿主支持的网页登录、套餐/API Key，或「复用本机授权」建立连接。地区、组织、项目和工作区需与授权实际所属范围一致，界面语言不会替你选择地区。
2. 打开「拉取模型」，检查目录来源和模型能力，选择至少一个对话模型后保存。默认**持续启用**；也可设置未来 366 天内的配置期限。
3. 打开「套餐与用量」。插件只请求相应的读取接口，不发送模型推理来试探余额，不把本地 token 计数当成套餐剩余量。
4. 若提示缺少权限，使用「连接配置」补充独立的查询授权或工作区信息。查询凭据不会进入模型调用路由。

新连接替换旧账号或改变地区、组织等路由范围时，需要重新导入模型。断开连接会移除本插件的凭据和当前 profile 中仍由插件拥有的路由修改；之后手工修改过的配置不会被强行覆盖。

## 模型能力与套餐权益

导入保存 ID、名称、输入/输出模态、工具支持、上下文长度、最大输出、推理档位，以及目录来源和权益证据。宿主支持的输入模态、上下文、输出上限、推理档位和协议兼容参数会写入真实模型路由；明确不支持工具调用的模型不会被当作工具模型使用。

- **账号目录**：例如 OpenRouter 的 `/models/user` 和 Copilot 的 picker/policy。反映接口当前允许列出的模型，仍受实际余额、配额和调用权限约束。
- **订阅通道目录**：例如 NanoGPT 使用订阅专用模型与调用地址，避免把按量付费目录当成套餐模型。
- **公共目录**：保存接口声明的能力，同时显示「套餐权益未确认」。
- **已安装目录**：MiniMax、Z.AI、阿里 Token Plan 使用 pi-ai 已安装目录及相应协议，没有声称它们来自当前账号的实时权益接口。

图片、视频模型可以保留能力信息，但本轮可执行的媒体工具仍以已实现的 xAI 路线为准。公共目录中的多模态条目不会自动变成已接通的生成接口。

## 支持范围

当前有 **23 个提供商定义、22 个用量读取适配器**。这些是代码覆盖数量，不等于 22 家全套餐实测。

| 来源 | 模型接入 | 用量与余量 |
| --- | --- | --- |
| ChatGPT / Codex、Claude、Copilot、Kimi、Grok | 原有 OAuth；部分支持套餐 Key 或本机复用 | 账号窗口、比例、重置及接口提供的额外余额 |
| MiniMax、Z.AI、阿里 Token Plan | 套餐 Key、地区与已安装模型目录 | 套餐接口；阿里个人套餐需额外 Console 授权 |
| OpenRouter | OAuth/Key、当前 Key 过滤的模型目录 | Key 预算；账户余额另需 Management Key |
| NanoGPT、ZenMux、OpenCode Go/Zen、Kilo、Poe、Synthetic、Chutes | 平台 Key、各自模型目录与调用通道 | 分平台读取窗口、积分、预算或余额；部分需要管理授权/工作区 |
| Nous Portal | 推理 Key、组织模型目录 | Portal OAuth 查询授权与推理 Key 分开 |
| DeepSeek API、New API 实例 | API Key；New API 显式配置 HTTPS API 根地址 | DeepSeek API 余额；New API 实例定义的 Key 配额单位 |
| Google Antigravity / Gemini CLI | 本轮未增加宿主模型调用协议 | 已实现远程查询；需要匹配的有效授权、项目和服务资格 |
| Qwen Code | 原有 OAuth 与模型导入 | 无本轮可确认的账号余量接口，显示不支持 |

DeepSeek 官方网页登录账号仍沿用宿主集成，与新增的 **DeepSeek API 余额**入口分开。详细接口、凭据要求和边界见 [连接与支持清单](docs/CONNECTIONS.md)。

## 长期保存与本机授权

「持续启用」保存的是模型配置，不会延长上游账号或令牌的有效期。网页登录授权继续由宿主凭据服务及 pi-ai 续期；API Key、查询授权也交给宿主凭据服务保存，不放进浏览器存储或模型配置 JSON。

本机复用支持 Codex 的固定 `auth.json` 和 OpenCode 的传统 `auth.json` 来源。目录来自服务端配置的 `CODEX_HOME`、`XDG_DATA_HOME` 或系统默认值，浏览器不能提交任意文件路径。

复用采用 **external-managed** 模式：每次使用时重读来源，**不复制刷新令牌，不与源 CLI 同时刷新**。源 CLI 退出或授权临期/过期时，需要在源 CLI 中续期；插件会阻止继续使用自己的旧镜像。本轮没有实现 Hermes 本机凭据导入或 OpenCode SQLite 凭据读取；Hermes 主要提供套餐查询、快照和能力导入的设计参考。

模型记录保存在当前 `profileContext.dir/dsh-oauth-pulls.json`；额度快照保存在同目录的 `dsh-oauth-usage.json`。两者不含访问令牌。写入采用受限文件权限、原子替换和跨进程锁；损坏文件会报错并保留原内容。旧的全局拉取文件不会被自动迁移，避免无法确定所属 profile 时改错路由。

凭据的物理位置和加密方式由宿主提供商决定；标准文件提供商通常使用 `DSH_HOME/.credentials.yaml`。多个 profile 若共用同一个凭据服务，也共享连接身份，断开连接会影响这些 profile 的授权。备份时应一并保留宿主凭据和目标 profile。

## 如何读用量

套餐窗口、Key 预算、组织共享额度和账户余额分别显示，不能直接相加。未知字段保持未知，不显示为 0 或无限；负余额、超额值不会被抹掉。Synthetic 的部分恢复时间与整段窗口重置分开。

每份快照保留来源和观察时间。普通请求在 60 秒内复用结果；手动刷新仍有 5 秒节流，供应商的 `Retry-After` 优先。临时网络失败可显示带「过期数据」标记的旧快照；换号、失去权限或授权无效时，不把旧账号的数据当作当前余额。查询成功但字段不全时显示「部分可用」。

OpenRouter 的管理余额标为管理凭据对应的独立账号范围；无法证明两把 Key 同属账号时，不合并成一个余额。阿里 Console、ZenMux Management、Nous Portal 等额外授权也应由用户确认对应的账号范围。

## 开发与验证

```sh
npm run link:peers -- --from /absolute/path/to/dsh-runtime
npm test
npm run verify:host -- --runtime /absolute/path/to/dsh-runtime
npm run verify:persistence -- --runtime /absolute/path/to/dsh-runtime
npm run verify:browser
npm run verify:subscriptions
```

`verify:host` 加载真实 Cordis、授权服务和模型路由 schema，供应商 HTTP 使用模拟响应。`verify:persistence` 使用真实文件凭据提供商与六个独立 Node 进程，验证 OAuth 续期轮换、失败保留、永久模型能力、查询授权和快照在重启后的状态。浏览器测试使用 Playwright；可通过 `DSH_PLAYWRIGHT_MODULE` 指定模块目录。

2026-11-16 验证结果：**292 项单元测试、两个宿主版本集成、六进程持久化、19 项订阅 UI 和 11 项原授权 UI 场景全部通过**。随后完成真实 Codex、OpenRouter、xAI 验收：目录分别返回 6、433、6 个模型，每家导入 2 个对话模型，独立进程重启后配置与能力一致，用量接口再次成功。OpenRouter 当前 Key 缺少 Management 权限，账户总余额保持未知，Key 用量与预算正常显示。

测试使用已有授权，未发出付费推理，也未重启或修改用户的日常桌面 profile。独立测试进程的恢复不能证明未来若干自然日内授权一直有效。详情见 [真实验收](docs/LIVE-VALIDATION-1.0.1.md) 与 [离线验证](docs/VALIDATION.md)。直接打开 `index.html` 仍是静态预览，不能证明账号已连接。
