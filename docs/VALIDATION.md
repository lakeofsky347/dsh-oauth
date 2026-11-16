# 本轮验证记录

日期：2026-11-16。本文件记录最初的离线验收；后续 `@lks347/dsh-oauth@1.0.1` 已增加 [Codex、OpenRouter、xAI 真实验收](LIVE-VALIDATION-1.0.1.md)。发布状态见 [发布说明](RELEASE-1.0.1.md)。原有工作区内容在实施前已备份。

## 通过的检查

| 检查 | 结果 | 证明的范围 |
| --- | --- | --- |
| `npm test` | 292 / 292 | 授权生命周期、模型目录与能力、固定本机来源、用量单位/窗口/权限、缓存与竞态、配置恢复 |
| DSH `0.2.0-rc.2` + pi-ai `0.87.1` | 通过 | 真实 Cordis、Authorization、Tools、客户端 Slot 和模型配置 schema |
| DSH `0.2.2-rc.3` + pi-ai `1.5.2` | 通过 | 新宿主同项集成；验证脚本提供新 Tools 接口要求的测试执行器，禁止实际执行工具 |
| 真实 `dsh-credentials-local 0.2.2-rc.3` | 六个独立进程通过 | 授权读回、刷新令牌轮换、失败保留、定时配置清理、永久模型能力、独立查询凭据和额度快照 |
| 订阅界面 Chromium | 19 / 19 | 中英、密钥与查询授权分开、来源选择、永久配置、状态显示、320/390px、键盘操作 |
| 原授权界面 Chromium | 11 / 11 | 手工输入、取消、弹窗、服务不可用、静态预览、xAI PKCE 和设备码备用 |
| 打包内容与格式检查 | 通过 | `npm pack --dry-run` 包含实现及中英文文档，不包含本地验证 artifacts；`git diff --check` 无格式错误 |

## 关键场景

- OpenRouter 使用当前 Key 的模型目录，保留输入模态、工具能力、上下文和输出上限；永久配置通过宿主真实 schema 后写入 profile。
- 推理授权与管理授权分别发送到正确接口；提供商列表、模型路由与额度快照不包含密钥。
- MiniMax 使用 Anthropic 协议；Z.AI、阿里使用地区对应的 Coding/Token Plan 通道，保留已安装模型的协议参数。
- MiniMax counts 新旧方向、Kimi 固定点钱包、Claude cents、Nous basis points、Kilo 微美元与各家 reset 单位均有独立样例。
- 缺失数据、零、负余额、超额和无限标志分开；不从普通目录推断套餐权益，不从本地计数推断剩余额度。
- 连接失效、缺权限、缺配置、限流和临时错误显示为明确状态；未知响应不会显示成「余额 0」。
- 六个并发写入进程不会覆盖其他提供商的保存记录；损坏 JSON 保留原文件并报错。
- 来源退出、过期、旧读取晚到、断开后请求晚到、其他网页登录覆盖，都不会恢复旧账号的有效授权或额度展示。

## 复现命令

将 runtime 替换为需要验证的本地 DSH 安装目录，测试使用临时 profile。

```sh
npm test
node scripts/verify-host.mjs --runtime /absolute/path/to/runtime
node scripts/verify-persistence.mjs --runtime /absolute/path/to/runtime
node scripts/verify-browser.mjs --out-dir artifacts/subscriptions-implementation/authorization
node scripts/verify-subscriptions-ui.mjs --out-dir artifacts/subscriptions-implementation/ui
npm pack --dry-run --json
git diff --check
```

持久化脚本要求与该 runtime 的 `dsh-credentials` 同版本的 `dsh-credentials-local`。若 runtime 没有包含它，可通过脚本的 `--credentials-local` 参数指定独立准备的匹配版本。浏览器脚本支持 `DSH_PLAYWRIGHT_MODULE`。

## 本地证据

证据目录为仓库中的 `artifacts/subscriptions-implementation/`，不进入 npm 包：

- `validation.json`：结果摘要、时间、源码哈希和测试边界。
- `unit-tests.log`：单元测试输出。
- `host-0.2.0-rc.2.json`、`host-0.2.2-rc.3.json`：宿主版本、实际源码哈希和结果。
- `persistence.json`：六个进程的检查结果。
- `ui/report.json` 和 `authorization/browser-pkce.json`：浏览器场景、页面错误和网络检查。
- `ui/subscriptions-zh-desktop.png`、`ui/subscriptions-en-320.png`、`ui/models-en.png`：原结构下的中英和模型能力截图。

## 尚未由本轮验证证明的内容

本文件列出的离线测试没有读取用户默认凭据目录、登录真实账号、发送付费推理或请求真实账户余额；供应商请求是 mock，宿主/浏览器/文件存储是真实运行环境。后续已有三个提供商的真实只读验收，范围与结果另见 [真实验收记录](LIVE-VALIDATION-1.0.1.md)。

因此，本轮可以证明实现按当前合同解析样例、保存状态并接入宿主，不能证明所有供应商的每个套餐、组织角色和地区都仍开放相同接口，也不能证明授权能持续若干自然日不失效。Google 模型协议、Hermes 本机导入、OpenCode SQLite、团队 ACS3 等明确未实现项见 [支持清单](CONNECTIONS.md)。旧 artifacts 中此前的真实账号记录不作为这轮新增用量适配的验收证据。
