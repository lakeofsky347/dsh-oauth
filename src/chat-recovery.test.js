import assert from "node:assert/strict";
import test from "node:test";
import { registerChatRecovery } from "./chat-recovery.js";
import { createGrantResolver } from "./grants.js";

const grant = (access = "offline-access") => ({ type: "oauth", access, refresh: "offline-refresh", expires: Date.now() + 3600000 });
const chunks = async function* () { yield { type: "finish", reason: { kind: "stop" } }; };
const collect = async (stream) => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };

/** Public event handler harness; no host internals, profiles, tokens, or network. */
function harness(resolveGrant = async () => grant()) {
  const handlers = new Map();
  const warnings = [];
  const value = { providers: { xai: { models: ["offline-chat"] } } };
  const ctx = {
    settings: { describe() { return [{ ns: "llm-pi-ai", value, user: { providers: {} } }]; } },
    logger: { warn(message) { warnings.push(message); } },
    on(name, handler) {
      const listeners = handlers.get(name) ?? [];
      listeners.push(handler);
      handlers.set(name, listeners);
      return () => { const index = listeners.indexOf(handler); if (index >= 0) listeners.splice(index, 1); };
    },
  };
  const dispose = registerChatRecovery(ctx, resolveGrant);
  const waterfall = (name, payload, terminal) => {
    const listeners = [...handlers.get(name) ?? []];
    let index = 0;
    const next = () => index < listeners.length ? listeners[index++](payload, next) : terminal();
    return next();
  };
  const emit = async (name, payload) => { for (const handler of [...handlers.get(name) ?? []]) await handler(payload); };
  const agent = { session: { id: "offline-session" } };
  const controller = new AbortController();
  const prepare = async ({ target = agent, turn = 1, step = 1, signal = controller.signal, provider = "xai", purpose, tracked = true } = {}) => {
    const payload = { agent: target, turn, step, signal };
    const config = { provider, model: "offline-chat" };
    if (tracked) assert.equal(await waterfall("agent/request", payload, async () => config), config);
    const options = Object.freeze({ ...config, sessionId: target.session.id, signal, messages: [], ...(purpose === undefined ? {} : { purpose }) });
    return { options, payload: { ...payload, provider } };
  };
  const stream = (options, terminal = chunks) => waterfall("llm/stream", options, terminal);
  const fail = (attempt, failure = { code: "AUTH", message: "xai API error (401): unauthorized" }, terminal = async () => undefined) =>
    waterfall("agent/request-error", { ...attempt.payload, failure }, terminal);
  return { ctx, value, warnings, handlers, waterfall, emit, agent, controller, prepare, stream, fail, dispose };
}

test("a clear xAI OAuth rejection persists recovery before retrying once in the same step", async () => {
  const observed = grant();
  const calls = [];
  let release;
  const stored = new Promise((resolve) => { release = resolve; });
  const host = harness(async (id, options) => {
    calls.push({ id, options });
    if (options) await stored;
    return observed;
  });
  const first = await host.prepare();
  const original = { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "xai API error (401): unauthorized" } } };
  assert.deepEqual(await collect(host.stream(first.options, async function* () { yield original; })), [original]);
  let settled = false;
  const recovery = host.fail(first).then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false, "a retry cannot precede durable grant resolution");
  release();
  assert.deepEqual(await recovery, { kind: "retry" });
  assert.deepEqual(calls[1], { id: "xai", options: { rejectedGrant: observed } });
  const second = await host.prepare();
  await collect(host.stream(second.options));
  let delegated = 0;
  assert.equal(await host.fail(second, undefined, async () => { delegated += 1; return "terminal"; }), "terminal");
  assert.equal(delegated, 1);
  assert.equal(calls.filter((call) => call.options).length, 1);
  const following = await host.prepare({ step: 2 });
  await collect(host.stream(following.options));
  assert.deepEqual(await host.fail(following), { kind: "retry" }, "a later step owns its own one-time recovery");
});

test("non-target streams and errors delegate without resolving credentials", async () => {
  for (const options of [{ provider: "anthropic" }, { purpose: "compaction" }, { purpose: "session-title" }, { tracked: false }]) {
    let resolutions = 0;
    const host = harness(async () => { resolutions += 1; return grant(); });
    const attempt = await host.prepare(options);
    const source = chunks();
    assert.equal(host.stream(attempt.options, () => source), source);
    assert.equal(await host.fail(attempt, undefined, async () => "delegated"), "delegated");
    assert.equal(resolutions, 0);
  }
});

test("only merged settings with no apiKeyEnv and a usable stored OAuth grant participate", async () => {
  for (const apiKeyEnv of ["XAI_API_KEY", ""]) {
    let resolutions = 0;
    const host = harness(async () => { resolutions += 1; return grant(); });
    host.value.providers.xai.apiKeyEnv = apiKeyEnv;
    const attempt = await host.prepare();
    await collect(host.stream(attempt.options));
    assert.equal(await host.fail(attempt, undefined, async () => "delegated"), "delegated");
    assert.equal(resolutions, 0);
  }
  for (const unusable of [undefined, { type: "api_key", access: "offline-key" }, { type: "oauth", access: "", refresh: "offline" }, { type: "oauth", access: "offline" }]) {
    let forced = 0;
    const host = harness(async (_id, options) => { if (options) forced += 1; return unusable; });
    const attempt = await host.prepare();
    await collect(host.stream(attempt.options));
    assert.equal(await host.fail(attempt, undefined, async () => "delegated"), "delegated");
    assert.equal(forced, 0);
  }
});

test("unknown AUTH, permission, billing, challenge, and network failures cannot refresh a grant", async () => {
  const failures = [
    { code: "AUTH", message: "unauthorized" },
    { code: "AUTH", message: "a request body mentions 401" },
    { code: "AUTH", message: "prefix xai API error (401): unauthorized" },
    { code: "AUTH", message: 'xai API error (403): {"code":"permission_denied"}' },
    { code: "AUTH", message: 'xai API error (403): {"code":"insufficient_scope"}' },
    { code: "AUTH", message: 'xai API error (403): {"code":"subscription:free-usage-exhausted"}' },
    { code: "AUTH", message: "xai API error (403): <html>Cloudflare challenge</html>" },
    { code: "AUTH", status: 403, message: '{"code":"bad-credentials"}' },
    { code: "AUTH", message: 'xai API error (403): {"message":"A user mentioned bad-credentials"}' },
    { code: "TRANSPORT", message: "network failure mentions 401" },
    { code: "ABORTED", status: 401, message: "xai API error (401): cancelled" },
  ];
  for (const failure of failures) {
    let forced = 0;
    const host = harness(async (_id, options) => { if (options) forced += 1; return grant(); });
    const attempt = await host.prepare();
    await collect(host.stream(attempt.options));
    assert.equal(await host.fail(attempt, failure, async () => "delegated"), "delegated");
    assert.equal(forced, 0, JSON.stringify(failure));
  }
});

test("structured 401 and precise xAI 403 bad-credentials permit one recovery", async () => {
  for (const failure of [
    { code: "AUTH", status: 401, message: "upstream denied access" },
    { code: "AUTH", message: 'xai API error (403): {"code":"unauthenticated:bad-credentials"}' },
    { code: "AUTH", message: 'xai API error (403): {"error":{"code":"bad-credentials"}}' },
    { code: "AUTH", message: "xai API error (403): The OAuth2 access token could not be validated." },
  ]) {
    let forced = 0;
    const host = harness(async (_id, options) => { if (options) forced += 1; return grant(); });
    const attempt = await host.prepare();
    await collect(host.stream(attempt.options));
    assert.deepEqual(await host.fail(attempt, failure), { kind: "retry" });
    assert.equal(forced, 1);
  }
});

test("session, signal, and agent identities must all match the observed normal chat attempt", async () => {
  for (const mismatch of ["session", "signal", "agent", "turn", "step"]) {
    let forced = 0;
    const host = harness(async (_id, options) => { if (options) forced += 1; return grant(); });
    const attempt = await host.prepare();
    if (mismatch === "session") {
      await collect(host.stream({ ...attempt.options, sessionId: "another-session" }));
    } else if (mismatch === "signal") {
      await collect(host.stream({ ...attempt.options, signal: new AbortController().signal }));
    } else {
      await collect(host.stream(attempt.options));
      if (mismatch === "agent") attempt.payload.agent = { session: { id: host.agent.session.id } };
      else attempt.payload[mismatch] += 1;
    }
    assert.equal(await host.fail(attempt, undefined, async () => "delegated"), "delegated");
    assert.equal(forced, 0, mismatch);
  }
});

test("cancellation before or during refresh never returns retry, while an active refresh may finish persistence", async () => {
  let forced = 0;
  const host = harness(async (_id, options) => { if (options) forced += 1; return grant(); });
  const attempt = await host.prepare();
  await collect(host.stream(attempt.options));
  host.controller.abort();
  assert.equal(await host.fail(attempt), undefined);
  assert.equal(forced, 0);

  let entered;
  let release;
  const refreshing = new Promise((resolve) => { entered = resolve; });
  const commit = new Promise((resolve) => { release = resolve; });
  let committed = false;
  const during = harness(async (_id, options) => {
    if (options) { entered(); await commit; committed = true; }
    return grant();
  });
  const pending = await during.prepare();
  await collect(during.stream(pending.options));
  const result = during.fail(pending);
  await refreshing;
  during.controller.abort();
  release();
  assert.equal(await result, undefined);
  assert.equal(committed, true);
});

test("failed observation or refresh delegates safely and leaves the original host failure in control", async () => {
  for (const phase of ["observation", "refresh"]) {
    const host = harness(async (_id, options) => {
      if (phase === "observation" || options) throw new Error("offline-private-detail");
      return grant();
    });
    const attempt = await host.prepare();
    let streamed = 0;
    await collect(host.stream(attempt.options, () => { streamed += 1; return chunks(); }));
    assert.equal(streamed, 1);
    assert.equal(await host.fail(attempt, undefined, async () => "original failure"), "original failure");
    assert.ok(host.warnings.every((message) => !message.includes("offline-private-detail")));
  }
});

test("another request's persisted refresh is reused rather than rotated again", async () => {
  const key = "llm-pi-ai/xai";
  let record = { kind: "grant", payload: grant("offline-old") };
  let exchanges = 0;
  const credentials = {
    async readRecord(requested) { assert.equal(requested, key); return structuredClone(record); },
    async modifyRecord(requested, mutate) {
      assert.equal(requested, key);
      const changed = await mutate(structuredClone(record));
      if (changed !== undefined) record = structuredClone(changed);
      return structuredClone(record);
    },
  };
  const resolveGrant = createGrantResolver(credentials, ({ credentials: store }) => ({
    getProvider() { return { auth: { oauth: { async refresh(current) { exchanges += 1; return { ...current, access: "unexpected" }; } } } }; },
    async getAuth(id) { return { auth: { apiKey: (await store.read(id)).access } }; },
  }));
  const host = harness(resolveGrant);
  const attempt = await host.prepare();
  await collect(host.stream(attempt.options));
  record = { kind: "grant", payload: { ...record.payload, access: "offline-concurrent-winner", refresh: "offline-rotated" } };
  assert.deepEqual(await host.fail(attempt), { kind: "retry" });
  assert.equal(exchanges, 0);
  assert.equal(record.payload.access, "offline-concurrent-winner");
});

test("idle/disposed agents release observations and context disposal removes all registered listeners", async () => {
  for (const event of ["agent/status", "agent/disposed"]) {
    const host = harness();
    const attempt = await host.prepare();
    await collect(host.stream(attempt.options));
    await host.emit(event, { agent: host.agent, status: "idle" });
    assert.equal(await host.fail(attempt, undefined, async () => "delegated"), "delegated");
  }
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const refreshing = new Promise((resolve) => { entered = resolve; });
  const host = harness(async (_id, options) => { if (options) { entered(); await blocked; } return grant(); });
  const attempt = await host.prepare();
  await collect(host.stream(attempt.options));
  const recovery = host.fail(attempt);
  await refreshing;
  await host.emit("dispose");
  assert.ok([...host.handlers.values()].every((listeners) => listeners.length === 0));
  release();
  assert.equal(await recovery, undefined);
  host.dispose();
});
