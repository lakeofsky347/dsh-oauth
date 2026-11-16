# 1.0.1 真实授权验收

验收时间：2026-11-16 14:10:59 UTC。目标发布包：`@lks347/dsh-oauth@1.0.1`。本文记录发布前验收，发布结果由后续发布记录确认。

使用本机已有的 Codex、OpenCode 和 DSH 授权完成了真实模型目录读取、模型导入、进程重启恢复及用量查询。供应商响应来自真实服务，不是模拟数据。测试没有发送对话、工具执行、图片或视频生成请求。

## 实测结果

| 连接 | 真实目录返回条目 | 导入对话模型 | 第二进程恢复 | 真实用量结果 |
| --- | ---: | ---: | --- | --- |
| ChatGPT / Codex | 6 | 2 | 所选模型、完整能力快照和永久配置一致 | `fresh`；1 个额度窗口、1 个 credits 余额项 |
| OpenRouter | 433 | 2 | 所选模型、完整能力快照和永久配置一致 | `partial`；5 个预算/消费/请求统计项；未提供账户 Management Key |
| Grok / xAI | 6 | 2 | 所选模型、完整能力快照和永久配置一致 | `fresh`；4 个额度窗口、1 个余额项 |

第一次导入与查询共发出 11 次供应商读取请求，第二进程发出 7 次，均返回 **HTTP 200**。模型条目数是本次账号目录的观察结果，可能随账号、权限和上游目录变化。

OpenRouter 的 `partial` 是预期权限边界：当前 Key 的真实额度/消费查询成功；账户级余额需要额外 Management Key。缺失的管理权限没有被表示为账户余额为零，也没有借用其他账号的凭据补齐。

报告保留查询状态、窗口/余额项数量、单位类型、来源和观察时间；不公开具体余额、额度数值、账号 ID、模型 ID、令牌或本机凭据路径。

可检查的脱敏结果见 [live-1.0.1.json](evidence/live-1.0.1.json)。

## 验证方法

[`scripts/verify-live.mjs`](../scripts/verify-live.mjs) 在一个临时隔离 profile 中启动实际 Cordis 插件及真实文件凭据提供商，通过 loopback HTTP 调用本插件的导入、模型读取、保存、用量和状态接口。

第一进程：

1. 复用已存在的授权，不重新发起登录。
2. 读取真实模型目录，每个提供商选择最多两个对话模型。
3. 使用宿主真实模型配置 schema 校验路由，保存完整模型能力，配置为持续启用。
4. 请求真实用量接口，保存观察快照。

第二个独立 Node 进程：

1. 从同一临时 profile 读回连接、模型配置、能力快照和路由，核对与第一进程一致。
2. 确认第一进程的用量观察已持久化。
3. 只移除临时 profile 的用量缓存，再次查询真实供应商目录与用量，避免把缓存读回当成第二次实网查询。
4. 确认连接状态和永久模型配置仍可见。

测试组合：

| 组件 | 版本 |
| --- | --- |
| Cordis | 4.1.0 |
| DSH credentials / credentials-local | 0.2.2-rc.3 |
| DSH llm-pi-ai | 0.2.2-rc.3 |
| pi-ai | 1.5.2 |

## 授权与隔离边界

Codex 与 OpenCode 采用外部 CLI 管理模式，只读固定来源。测试前后两个来源文件的字节哈希均未变化；测试没有复制它们的刷新令牌。

xAI 使用原始宿主凭据文件中的 canonical OAuth 记录。测试不复制刷新令牌到新的刷新链；若需要续期，只能通过宿主原子接口更新原记录。本次记录的请求全部是 GET，**没有触发真实刷新令牌交换**。

插件自己的连接记录、访问引用、模型设置、拉取记录和用量缓存均位于临时目录；测试结束后清理。临时凭据文件权限为 `0600`。供应商网络请求只允许固定目录、用量和明确的刷新端点，推理路径被拒绝。

本次验证的是**隔离 profile 中的实际插件在两个独立进程之间恢复**，没有退出或重启用户正在使用的桌面应用，也没有替换用户桌面安装的插件。

## 复现

计划文件仅包含提供商与凭据来源描述，不包含令牌；需设置为仅当前用户可读写。以下路径均为占位符：

```json
{
  "entries": [
    {"provider": "openai-codex", "mode": "local", "source": "codex"},
    {"provider": "openrouter", "mode": "local", "source": "opencode"},
    {
      "provider": "xai",
      "mode": "native",
      "credentialsFile": "/absolute/canonical/.credentials.yaml"
    }
  ]
}
```

```sh
chmod 600 /absolute/private/live-plan.json
node scripts/verify-live.mjs \
  --runtime /absolute/path/to/dsh-runtime \
  --plan /absolute/private/live-plan.json \
  --out /absolute/path/to/live-result.json
```

不使用真实授权时，可先验证测试工具自身：

```sh
node scripts/verify-live.mjs --self-test \
  --runtime /absolute/path/to/dsh-runtime \
  --out /absolute/path/to/self-test-result.json
```

`--self-test` 使用临时授权样例并拦截所有供应商请求，不能替代本页记录的实网验收。

## 结论范围

三种本机已有授权均通过了本次真实模型导入、进程恢复和用量查询检查。该结果不扩展为其他供应商、套餐、地区或组织角色的真实验收；完整支持边界仍见 [连接清单](CONNECTIONS.md)。

没有付费推理、真实令牌自然过期后的续期测试或跨若干自然日的持续运行测试。因此，本次不能证明所有可见模型都能成功生成，也不能证明授权能长期保持有效。
