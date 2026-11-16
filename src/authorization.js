import { randomUUID } from "node:crypto";

const abortError = (message = "授权输入已撤回") => Object.assign(new Error(message), { name: "AbortError" });
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

/**
 * Bridge the harness interaction callbacks to short HTTP requests. Only the
 * public snapshot is stored in `sessions`; answers and cancellation handles stay
 * private and are never serialized or persisted.
 */
export function createAuthorizationSessions({ sessions = new Map(), readyTimeoutMs = 8000, attemptTimeoutMs = 10 * 60 * 1000, commitGraceMs = 90000 } = {}) {
  const active = new Map();

  function get(id) {
    const state = sessions.get(id);
    if (state === undefined) return undefined;
    return {
      attemptId: state.attemptId,
      status: state.status ?? "pending",
      pending: state.status === "pending",
      url: state.url ?? "",
      code: state.code ?? "",
      message: state.message ?? "",
      ...(state.error ? { error: state.error } : {}),
      ...(state.prompt ? { prompt: {
        ...state.prompt,
        ...(state.prompt.options ? { options: state.prompt.options.map((option) => ({ ...option })) } : {}),
      } } : {}),
    };
  }

  function current(id, attemptId) {
    const handle = active.get(id);
    if (!handle || handle.state.status !== "pending") throw new Error("这次登录已经结束，请重新登录");
    if (typeof attemptId !== "string" || handle.state.attemptId !== attemptId) {
      throw new Error("登录尝试已更新，请刷新后重试");
    }
    return handle;
  }

  function publishPrompt(handle) {
    const next = handle.prompts[0];
    if (next) handle.state.prompt = next.public;
    else delete handle.state.prompt;
    handle.ready();
  }

  function removePrompt(handle, entry) {
    const index = handle.prompts.indexOf(entry);
    if (index >= 0) handle.prompts.splice(index, 1);
    entry.signal?.removeEventListener("abort", entry.withdraw);
    publishPrompt(handle);
  }

  function finish(handle, status, error) {
    if (handle.state.status !== "pending") return;
    handle.state.status = status;
    if (error) handle.state.error = error;
    clearTimeout(handle.lifetime);
    for (const entry of [...handle.prompts]) {
      removePrompt(handle, entry);
      entry.reject(abortError(status === "authorized" ? "浏览器回调已完成" : "这次登录已经结束"));
    }
    handle.ready();
  }

  async function begin(authorization, id, key) {
    const existing = active.get(id);
    if (existing?.state.status === "pending") return get(id);
    const flow = authorization.describe(key);
    if (flow?.inFlight) throw new Error("该提供商正在其他窗口登录，请先完成或取消那次登录");
    const controller = new AbortController();
    const state = { attemptId: randomUUID(), status: "pending", url: "", code: "", message: "正在启动提供商登录" };
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const handle = { state, authorization, key, controller, prompts: [], ready: readyResolve };
    sessions.set(id, state);
    active.set(id, handle);
    const timeout = () => {
      if (handle.state.status !== "pending") return;
      if (authorization.isCommitting?.(key)) {
        handle.commitDeadline ??= Date.now() + commitGraceMs;
        if (Date.now() < handle.commitDeadline) {
          state.message = "授权回调已收到，正在核验并保存，请稍候";
          handle.lifetime = setTimeout(timeout, Math.min(1000, commitGraceMs));
          handle.lifetime.unref?.();
          return;
        }
      }
      finish(handle, "error", "登录等待超时，请重新登录");
      controller.abort(abortError("登录等待超时"));
      authorization.cancel?.(key);
    };
    handle.lifetime = setTimeout(timeout, attemptTimeoutMs);
    handle.lifetime.unref?.();

    const interaction = {
      notify(notice) {
        if (state.status !== "pending" || active.get(id) !== handle) return;
        if (typeof notice.message === "string") state.message = notice.message;
        if (typeof notice.url === "string" && notice.url.length > 0) {
          try {
            const url = new URL(notice.url);
            if (url.protocol === "https:" || url.protocol === "http:") state.url = url.href;
          } catch { /* A malformed notice must not navigate the browser. */ }
        }
        if (typeof notice.code === "string") state.code = notice.code;
        handle.ready();
      },
      prompt(prompt) {
        if (state.status !== "pending" || controller.signal.aborted || prompt.signal?.aborted) {
          return Promise.reject(abortError());
        }
        if (!["text", "secret", "select"].includes(prompt.kind)) return Promise.reject(new Error("不支持的授权输入类型"));
        return new Promise((resolve, reject) => {
          const entry = {
            public: {
              id: randomUUID(),
              kind: prompt.kind,
              message: String(prompt.message ?? "请补充授权信息"),
              ...(typeof prompt.placeholder === "string" ? { placeholder: prompt.placeholder } : {}),
              ...(prompt.kind === "select" ? { options: (prompt.options ?? []).map((option) => ({
                id: String(option.id), label: String(option.label),
                ...(typeof option.description === "string" ? { description: option.description } : {}),
              })) } : {}),
            },
            resolve, reject, signal: prompt.signal,
          };
          entry.withdraw = () => {
            removePrompt(handle, entry);
            reject(abortError());
          };
          handle.prompts.push(entry);
          prompt.signal?.addEventListener("abort", entry.withdraw, { once: true });
          // Abort can race registration; do not leave a losing manual prompt open.
          if (prompt.signal?.aborted) entry.withdraw();
          else publishPrompt(handle);
        });
      },
    };
    // Defer begin so synchronous callback throws and rejections share one path.
    void Promise.resolve().then(() => authorization.begin({ key, method: "oauth", interaction, signal: controller.signal }))
      .then((outcome) => finish(handle, outcome.status === "authorized" ? "authorized" : "cancelled"))
      .catch((error) => finish(handle, controller.signal.aborted ? "cancelled" : "error", controller.signal.aborted ? undefined : errorMessage(error)));
    let readyTimer;
    await Promise.race([ready, new Promise((resolve) => {
      readyTimer = setTimeout(resolve, readyTimeoutMs);
    })]);
    clearTimeout(readyTimer);
    return get(id);
  }

  function answer(id, { attemptId, promptId, value } = {}) {
    const handle = current(id, attemptId);
    const entry = handle.prompts[0];
    if (!entry || entry.public.id !== promptId) throw new Error("这项授权输入已撤回或更新，请等待最新状态");
    if (typeof value !== "string") throw new Error("需要填写授权输入");
    if (value.length > 16384) throw new Error("授权输入过长");
    if (entry.public.kind === "select" && !entry.public.options.some((option) => option.id === value)) {
      throw new Error("请选择提供商给出的选项");
    }
    removePrompt(handle, entry);
    entry.resolve(value);
    return get(id);
  }

  function cancel(id, { attemptId } = {}) {
    const state = sessions.get(id);
    if (!state) throw new Error("没有这次登录记录");
    if (typeof attemptId !== "string" || state.attemptId !== attemptId) throw new Error("登录尝试已更新，请刷新后重试");
    if (state.status !== "pending") return get(id);
    const handle = current(id, attemptId);
    if (handle.authorization.isCommitting?.(handle.key)) {
      handle.state.message = "授权回调已收到，正在核验并保存，请稍候";
      return get(id);
    }
    finish(handle, "cancelled");
    handle.controller.abort(abortError("用户取消登录"));
    handle.authorization.cancel?.(handle.key);
    return get(id);
  }

  function clear(id) {
    const handle = active.get(id);
    if (handle?.state.status === "pending") {
      finish(handle, "cancelled");
      handle.controller.abort(abortError("登录记录已移除"));
      handle.authorization.cancel?.(handle.key);
    }
    active.delete(id);
    sessions.delete(id);
  }

  function dispose() {
    for (const id of active.keys()) clear(id);
  }

  return { begin, get, answer, cancel, clear, dispose };
}
