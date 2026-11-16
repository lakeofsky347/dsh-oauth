# @lks347/dsh-oauth 1.0.1

本版本将订阅接入、模型能力保存和用量查询接成同一条连接流程，保留原来的页面结构。包名为 `@lks347/dsh-oauth`；配置条目 ID、凭据 scope 和 profile 文件名继续使用原有名称，避免升级时丢失状态。

## 变更

- 接入官方订阅及第三方平台，共 23 个提供商定义、22 个用量读取适配器；各平台的完整程度见 [支持清单](CONNECTIONS.md)。
- 区分账号目录、订阅目录、公共目录和已安装目录，保存模型能力并写入宿主可支持的路由字段。
- 模型配置默认持续启用，保留旧到期行为；增加跨进程保存、账号切换和失效授权的处理。
- 复用固定位置的 Codex / OpenCode 传统 `auth.json`，刷新责任仍归源 CLI。
- 分开保存调用与查询授权，区分套餐窗口、Key 预算、共享额度、余额及部分恢复时间。
- 在原页面结构中增加中英切换、连接配置、能力说明与用量状态。

## 验收

292 项单元测试、两套宿主组合、六进程持久化、19 项新订阅界面和 11 项原 OAuth 浏览器场景通过。真实 Codex、OpenRouter、xAI 模型目录和用量读取也通过；每家导入两个模型，在新的独立进程中恢复了相同的配置与能力。

OpenRouter 当前授权只能确认 Key 用量与预算，没有 Management Key 时不显示账户总余额。测试未调用付费推理，也未重启用户日常桌面 profile。详见 [真实验收](LIVE-VALIDATION-1.0.1.md) 和 [离线验证](VALIDATION.md)。

最终安装包使用 `verify-package` 做实际离线 npm 安装，再从安装后的包运行宿主与持久化检查，核对包名、客户端模块 ID、bundle patch、exports 和源码字节。

## 安装与发布状态

本地安装包名称为 `lks347-dsh-oauth-1.0.1.tgz`：

```sh
dsh plugin --profile desktop add /absolute/path/to/lks347-dsh-oauth-1.0.1.tgz --offline
```

版本 `1.0.0` 曾被撤回，不可复用，因此采用 `1.0.1`。npm 对整包撤回规定了 24 小时重发等待期；依据 2026-11-16 的撤回确认时间，保守可再次发布时间为 **2026-11-17 12:27:26 UTC / 新加坡时间 20:27:26**。[npm 官方规则](https://docs.npmjs.com/policies/unpublish/)

Git 仓库、tag 或本地 tgz 的存在不代表 npm 已接收发布；注册表的实际状态可用以下命令确认：

```sh
npm view @lks347/dsh-oauth@1.0.1 version dist.integrity
```

升级不会自动给账号增加订阅权限。Google 模型协议、Hermes 本机导入、OpenCode SQLite、团队账单等未完成范围继续明确标注，没有宣称全市场套餐均已实测。
