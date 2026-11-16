/** Resolve request credentials through pi-ai's public refresh API and DSH's atomic record store. */
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { refreshQwen } from "./qwen.js";

export const QWEN_KEY_NAME = "QWEN_OAUTH_ACCESS";
const recordKey = (id) => credentialKey(id === "qwen" ? "dsh-oauth" : "llm-pi-ai", id);

/** Only grants are accepted; ambient API keys never stand in for a signed-in account. */
export function createGrantResolver(credentials, modelsFactory = builtinModels) {
  // Request auth may differ from the stored access token (for example Copilot).
  // Keep the rejected grant's storage snapshot private, never in API responses.
  const observed = new WeakMap();
  const remember = (id, grant, stored) => {
    observed.set(grant, { id, access: stored.access, refresh: stored.refresh, expires: stored.expires, payload: { ...stored } });
    return grant;
  };
  const unchanged = (current, rejected) => current && current.access === rejected.access &&
    current.refresh === rejected.refresh && current.expires === rejected.expires;
  const store = {
    async read(id) {
      const record = await credentials.readRecord(recordKey(id));
      return record?.kind === "grant" ? record.payload : undefined;
    },
    async list() { return []; },
    async modify(id, mutate) {
      const next = await credentials.modifyRecord(recordKey(id), async (current) => {
        const changed = await mutate(current?.kind === "grant" ? current.payload : undefined);
        return changed === undefined ? undefined : { kind: "grant", payload: JSON.parse(JSON.stringify(changed)) };
      });
      return next?.kind === "grant" ? next.payload : undefined;
    },
    async delete(id) { await credentials.deleteRecord(recordKey(id)); },
  };
  const models = modelsFactory({
    credentials: store,
    authContext: { async env() { return undefined; }, async fileExists() { return false; } },
  });
  const resolve = async (id, { rejectedGrant } = {}) => {
    const rejected = rejectedGrant === undefined ? undefined : observed.get(rejectedGrant);
    if (rejectedGrant !== undefined && rejected?.id !== id) {
      throw new Error("无法核对被拒绝的 OAuth 请求凭据，请重新读取连接状态");
    }
    let payload = await store.read(id);
    if (!payload || typeof payload.access !== "string" || payload.access.length === 0) {
      throw new Error("先完成这个提供商的 OAuth 登录，再拉取模型");
    }
    if (id === "qwen") {
      if (rejected || typeof payload.expires !== "number" || payload.expires <= Date.now() + 300000) {
        payload = await store.modify(id, async (current) => {
          if (!current) return undefined;
          if (rejected ? !unchanged(current, rejected) : typeof current.expires === "number" && current.expires > Date.now() + 300000) return undefined;
          return refreshQwen(current);
        });
      }
      if (!payload) throw new Error("通义千问登录已断开，请重新登录");
      // Qwen's custom OpenAI route consumes a credential reference, not pi-ai's store.
      await credentials.set(QWEN_KEY_NAME, payload.access);
      return remember(id, payload, payload);
    }
    if (rejected) {
      // The upstream can revoke an access token before its advertised expiry.
      // Exchange only the credential the failed request actually used; another
      // process may already have refreshed it while this request was in flight.
      const oauth = models.getProvider?.(id)?.auth?.oauth;
      if (typeof oauth?.refresh !== "function") throw new Error(`${id} 的适配器没有提供 OAuth 续期接口；已保留本地授权`);
      payload = await store.modify(id, async (current) => {
        if (!unchanged(current, rejected)) return undefined;
        if (current.type !== "oauth" || typeof current.refresh !== "string" || !current.refresh) {
          throw new Error(`${id} 的已保存授权缺少刷新令牌，需要重新登录`);
        }
        try {
          // Once a rotating refresh starts, persist it even if the panel leaves.
          return await oauth.refresh(current, AbortSignal.timeout(15000));
        } catch (cause) {
          throw new Error(`${id} 的 OAuth 自动续期失败；本地授权已保留，请稍后重试。若上游已撤销授权，需要重新登录`, { cause });
        }
      });
      if (!payload) throw new Error("OAuth 登录已断开，请重新登录");
    }
    const resolved = await models.getAuth(id, { signal: AbortSignal.timeout(20000) });
    if (typeof resolved?.auth?.apiKey !== "string" || resolved.auth.apiKey.length === 0) {
      throw new Error(`${id} 的 OAuth 请求凭据不可用，请重新登录`);
    }
    payload = await store.read(id);
    if (!payload) throw new Error("OAuth 登录已断开，请重新登录");
    // Another process may have committed a newer grant after getAuth read it.
    // Derive request auth from the same payload we remember for recovery.
    const oauth = models.getProvider?.(id)?.auth?.oauth;
    const auth = typeof oauth?.toAuth === "function" ? await oauth.toAuth(payload) : resolved.auth;
    if (typeof auth?.apiKey !== "string" || !auth.apiKey) {
      throw new Error(`${id} 的 OAuth 请求凭据不可用，请重新登录`);
    }
    return remember(id, {
      ...payload,
      access: auth.apiKey,
      ...(auth.headers ? { requestHeaders: auth.headers } : {}),
      ...(auth.baseUrl ? { apiBase: auth.baseUrl } : {}),
    }, payload);
  };
  resolve.rawGrant = grant => observed.get(grant)?.payload;
  return resolve;
}
