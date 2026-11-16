/** Recover one explicitly rejected xAI OAuth chat attempt through public DSH events. */
import { OAuthRequestError } from "./request-errors.js";

const usableGrant = (grant) => grant?.type === "oauth" && typeof grant.access === "string" && grant.access.length > 0 &&
  typeof grant.refresh === "string" && grant.refresh.length > 0;

function authenticationRejected(failure) {
  if (!failure || failure.code === "ABORTED") return false;
  if (failure.status === 401) return true;
  // pi-ai exposes this provider/status prefix after normalizing an SDK error.
  // A number or credential-related word elsewhere in the body is insufficient.
  const match = /^xai API error \((401|403)\):\s?([\s\S]*)$/.exec(failure.message ?? "");
  return match !== null && new OAuthRequestError("xai", Number(match[1]), match[2]).authenticationRejected;
}

/**
 * Observe a grant before a normal loop request, then refresh it at most once per
 * agent/turn/step. This is a pre-request observation, not proof of the credential
 * pi-ai subsequently selected; resolveGrant compares it again under the store
 * lock so an intervening refresh is reused rather than rotated a second time.
 */
export function registerChatRecovery(ctx, resolveGrant) {
  const steps = new WeakMap();
  const active = new Map();
  const removers = [];
  let disposed = false;

  const oauthRoute = () => {
    try {
      const row = ctx.settings.describe({ redactSecrets: false }).find((entry) => entry.ns === "llm-pi-ai");
      const route = row?.value?.providers?.xai;
      return route !== null && typeof route === "object" && route.apiKeyEnv === undefined;
    } catch { return false; }
  };
  const clearAgent = (agent) => {
    const id = agent?.session?.id;
    if (active.get(id)?.agent === agent) active.delete(id);
    if (agent && typeof agent === "object") steps.delete(agent);
  };

  removers.push(ctx.on("agent/request", async (payload, next) => {
    const config = await next();
    const { agent, turn, step, signal } = payload;
    const id = agent?.session?.id;
    if (disposed || !agent || typeof agent !== "object" || typeof id !== "string" || !signal || signal.aborted ||
      config?.provider !== "xai" || !oauthRoute()) {
      if (active.get(id)?.agent === agent) active.delete(id);
      return config;
    }
    let state = steps.get(agent);
    if (!state || state.turn !== turn || state.step !== step || state.signal !== signal) {
      state = { turn, step, signal, recovered: false };
      steps.set(agent, state);
    }
    active.set(id, { agent, state, started: false, observed: undefined });
    return config;
  }));

  removers.push(ctx.on("llm/stream", (options, next) => {
    const entry = active.get(options.sessionId);
    if (disposed || options.provider !== "xai" || options.purpose !== undefined ||
      !entry || entry.started || options.signal !== entry.state.signal || options.signal?.aborted || !oauthRoute()) return next();
    entry.started = true;
    return (async function* () {
      try {
        const observed = await resolveGrant("xai");
        if (!disposed && active.get(options.sessionId) === entry && !options.signal.aborted && oauthRoute() && usableGrant(observed)) {
          entry.observed = observed;
        }
      } catch {
        // The host retains ownership of an unconfigured/failed auth request.
        // Do not replace its stream or force a refresh without an observation.
      }
      if (disposed || options.signal.aborted) return;
      yield* next();
    })();
  }));

  removers.push(ctx.on("agent/request-error", async (payload, next) => {
    if (disposed) return;
    const { agent, turn, step, provider, signal, failure } = payload;
    const entry = active.get(agent?.session?.id);
    if (provider !== "xai" || !entry || entry.agent !== agent || entry.state.turn !== turn || entry.state.step !== step ||
      entry.state.signal !== signal || !usableGrant(entry.observed) || !oauthRoute() || !authenticationRejected(failure) || entry.state.recovered) return next();
    if (signal.aborted) return;
    entry.state.recovered = true;
    const observed = entry.observed;
    entry.observed = undefined;
    try {
      await resolveGrant("xai", { rejectedGrant: observed });
    } catch {
      if (disposed || signal.aborted) return;
      ctx.logger?.warn("dsh-oauth: xAI chat OAuth recovery failed; stored authorization was retained");
      return next();
    }
    if (disposed || signal.aborted) return;
    return { kind: "retry" };
  }));

  removers.push(ctx.on("agent/status", ({ agent, status }) => { if (status === "idle") clearAgent(agent); }));
  removers.push(ctx.on("agent/disposed", ({ agent }) => clearAgent(agent)));
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    active.clear();
    for (const remove of removers.splice(0)) remove();
  };
  removers.push(ctx.on("dispose", dispose));
  return dispose;
}
