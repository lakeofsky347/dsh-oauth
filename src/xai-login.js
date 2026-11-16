import { isDeepStrictEqual } from "node:util";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { loginXaiBrowser } from "./xai-browser.js";

const KEY = credentialKey("llm-pi-ai", "xai");
const cancelled = () => Object.assign(new Error("xAI 登录已取消"), { name: "AbortError" });

/** Browser runner over the canonical xAI grant; it does not register or duplicate a DSH credential flow. */
export function createXaiBrowserAuthorization(ctx, authorization, { login = loginXaiBrowser } = {}) {
  let active;
  let generation = 0;
  let recordEpoch = 0;
  let disposed = false;
  const unwatch = ctx.on("credentials/record-updated", (key) => {
    if (key === KEY) recordEpoch += 1;
  });

  function assertKey(key) {
    if (key !== KEY) throw new Error("浏览器授权仅支持 xAI 账号");
  }

  function assertCurrent(attempt) {
    attempt.signal.throwIfAborted();
    if (disposed || active !== attempt || generation !== attempt.generation) throw cancelled();
  }

  function assertUnchanged(attempt) {
    assertCurrent(attempt);
    if (authorization.describe(KEY)?.inFlight) throw new Error("xAI 正在其他窗口登录，请完成或取消后重试");
    if (recordEpoch !== attempt.recordEpoch) throw new Error("xAI 凭据在登录期间已更改，请重新开始");
  }

  function describe(key) {
    if (key !== KEY) return undefined;
    return {
      key: KEY,
      label: "xAI (Grok)",
      methods: [{ id: "oauth", label: "浏览器登录" }],
      inFlight: active !== undefined || authorization.describe(KEY)?.inFlight === true,
    };
  }

  async function begin({ key, method = "oauth", interaction, signal }) {
    assertKey(key);
    if (method !== "oauth") throw new Error("xAI 浏览器授权不支持该登录方式");
    if (disposed) throw new Error("xAI 浏览器授权已卸载");
    if (signal?.aborted) return { status: "cancelled" };
    if (active || authorization.describe(KEY)?.inFlight) throw new Error("xAI 已有登录正在进行，请完成或取消后重试");
    const controller = new AbortController();
    const attempt = {
      generation: ++generation,
      recordEpoch,
      controller,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      phase: "starting",
    };
    active = attempt;
    const withdraw = () => {
      if (active === attempt) {
        generation += 1;
        active = undefined;
      }
      controller.abort(signal?.reason ?? cancelled());
    };
    signal?.addEventListener("abort", withdraw, { once: true });
    try {
      const stored = await ctx.credentials.readRecord(KEY);
      assertUnchanged(attempt);
      const snapshot = stored === undefined ? undefined : structuredClone(stored);
      attempt.phase = "browser";
      const grant = await login({
        notify: interaction.notify,
        prompt: interaction.prompt,
        signal: attempt.signal,
        onExchangeStart() {
          assertUnchanged(attempt);
          attempt.phase = "exchanging";
        },
      });
      assertUnchanged(attempt);
      await ctx.credentials.modifyRecord(KEY, async (current) => {
        // Check again after acquiring DSH's record lock; never hold it while waiting for the browser.
        assertUnchanged(attempt);
        if (!isDeepStrictEqual(current, snapshot)) throw new Error("xAI 凭据在登录期间已更改，请重新开始");
        attempt.phase = "committing";
        return { kind: "grant", payload: JSON.parse(JSON.stringify(grant)) };
      });
      // A logout may have queued deletion behind this write. Do not publish a late success or write again.
      assertCurrent(attempt);
      return { status: "authorized" };
    } catch (error) {
      if (attempt.signal.aborted || disposed || generation !== attempt.generation) return { status: "cancelled" };
      throw error;
    } finally {
      signal?.removeEventListener("abort", withdraw);
      if (active === attempt) active = undefined;
    }
  }

  /** Strong invalidation for logout/clear; ordinary UI cancellation must defer while isCommitting is true. */
  function cancel(key) {
    if (key !== KEY || !active) return;
    const attempt = active;
    active = undefined;
    generation += 1;
    attempt.controller.abort(cancelled());
  }

  function isCommitting(key) {
    return key === KEY && active !== undefined && ["exchanging", "committing"].includes(active.phase);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel(KEY);
    unwatch();
  }

  return { describe, begin, cancel, isCommitting, dispose };
}
