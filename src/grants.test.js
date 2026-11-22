import assert from "node:assert/strict";
import test from "node:test";
import { createGrantResolver, QWEN_KEY_NAME } from "./grants.js";

const clone = (value) => value === undefined ? undefined : structuredClone(value);

/** Simulate DSH modifyRecord's exclusive callback and undefined-means-unchanged contract. */
function memoryCredentials(initial = {}) {
  const records = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
  const references = new Map();
  const calls = [];
  let pending = Promise.resolve();
  return {
    records, references, calls,
    async readRecord(key) { return clone(records.get(key)); },
    async modifyRecord(key, mutate) {
      const operation = pending.then(async () => {
        calls.push(key);
        const current = clone(records.get(key));
        const changed = await mutate(current);
        if (changed !== undefined) records.set(key, clone(changed));
        return clone(records.get(key));
      });
      pending = operation.catch(() => {});
      return operation;
    },
    async deleteRecord(key) { records.delete(key); },
    async set(name, value) { references.set(name, value); },
  };
}

test("pi-ai refresh runs inside DSH's atomic record callback and a competing no-op preserves the refreshed grant", async () => {
  const key = "llm-pi-ai/openai-codex";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: { type: "oauth", access: "old", refresh: "refresh-old" } } });
  let release;
  const network = new Promise((resolve) => { release = resolve; });
  let entered;
  const refreshing = new Promise((resolve) => { entered = resolve; });
  let exchanges = 0;
  const resolveGrant = createGrantResolver(credentials, ({ credentials: store }) => ({
    async getAuth(id, options) {
      assert.ok(options.signal instanceof AbortSignal);
      const grant = await store.modify(id, async (current) => {
        if (current.access !== "old") return undefined;
        exchanges += 1;
        entered();
        await network;
        return { ...current, access: "fresh", refresh: "refresh-new", optional: undefined };
      });
      return { auth: { apiKey: grant.access, headers: { "upstream-header": "identity" }, baseUrl: "https://upstream.example.test/v1" } };
    },
  }));
  const first = resolveGrant("openai-codex");
  await refreshing;
  const second = resolveGrant("openai-codex");
  release();
  const results = await Promise.all([first, second]);
  assert.equal(exchanges, 1);
  assert.deepEqual(credentials.calls, [key, key]);
  assert.deepEqual(credentials.records.get(key), { kind: "grant", payload: { type: "oauth", access: "fresh", refresh: "refresh-new" } });
  for (const grant of results) {
    assert.equal(grant.access, "fresh");
    assert.equal(grant.refresh, "refresh-new");
    assert.deepEqual(grant.requestHeaders, { "upstream-header": "identity" });
    assert.equal(grant.apiBase, "https://upstream.example.test/v1");
  }
});

test("account requests reject absent or API-key records without falling back to ambient credentials", async () => {
  for (const record of [undefined, { kind: "api-key", key: "ambient-key" }]) {
    const credentials = memoryCredentials(record ? { "llm-pi-ai/anthropic": record } : {});
    let authCalls = 0;
    const resolveGrant = createGrantResolver(credentials, (options) => {
      assert.equal(typeof options.authContext.env, "function");
      return { async getAuth() { authCalls += 1; return { auth: { apiKey: "ambient-key" } }; } };
    });
    await assert.rejects(resolveGrant("anthropic"), /先完成.*OAuth 登录/);
    assert.equal(authCalls, 0);
  }
  const credentials = memoryCredentials({ "llm-pi-ai/anthropic": { kind: "grant", payload: { access: "signed-in" } } });
  const resolveGrant = createGrantResolver(credentials, ({ authContext }) => ({
    async getAuth() {
      assert.equal(await authContext.env("ANTHROPIC_API_KEY"), undefined);
      assert.equal(await authContext.fileExists("/ambient/credentials"), false);
      return { auth: { apiKey: "signed-in" } };
    },
  }));
  assert.equal((await resolveGrant("anthropic")).access, "signed-in");
});

test("a disconnect during upstream authentication prevents using the resolved request credential", async () => {
  const key = "llm-pi-ai/github-copilot";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: { access: "old" } } });
  const resolveGrant = createGrantResolver(credentials, () => ({
    async getAuth() {
      await credentials.deleteRecord(key);
      return { auth: { apiKey: "fresh" } };
    },
  }));
  await assert.rejects(resolveGrant("github-copilot"), /登录已断开/);
});

test("upstream authentication without a usable request credential fails before returning a grant", async () => {
  const credentials = memoryCredentials({ "llm-pi-ai/xai": { kind: "grant", payload: { access: "old" } } });
  const resolveGrant = createGrantResolver(credentials, () => ({ async getAuth() { return { auth: { apiKey: "" } }; } }));
  await assert.rejects(resolveGrant("xai"), /请求凭据不可用/);
});

test("Qwen refresh persists its new access token without losing a non-rotated refresh token or resource", async (t) => {
  const key = "dsh-oauth/qwen";
  const old = { access: "expired", refresh: "refresh-old", expires: Date.now() - 1000, resourceUrl: "https://portal.qwen.ai/v1" };
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: old } });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://chat.qwen.ai/api/v1/oauth2/token");
    assert.equal(init.body.get("grant_type"), "refresh_token");
    assert.equal(init.body.get("refresh_token"), "refresh-old");
    return new Response(JSON.stringify({ access_token: "fresh", expires_in: 7200 }), { status: 200 });
  });
  const before = Date.now();
  const resolveGrant = createGrantResolver(credentials, () => ({ async getAuth() { assert.fail("Qwen owns its refresh protocol"); } }));
  const grant = await resolveGrant("qwen");
  assert.equal(grant.access, "fresh");
  assert.equal(grant.refresh, "refresh-old");
  assert.equal(grant.resourceUrl, old.resourceUrl);
  assert.ok(grant.expires >= before + 7200000 && grant.expires <= Date.now() + 7200000);
  assert.deepEqual(credentials.records.get(key), { kind: "grant", payload: grant });
  assert.equal(credentials.references.get(QWEN_KEY_NAME), "fresh");
});

test("Qwen rotating refresh tokens and resources replace the corresponding stored values", async (t) => {
  const key = "dsh-oauth/qwen";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: {
    access: "expired", refresh: "refresh-old", expires: 1, resourceUrl: "https://old.example.test/v1",
  } } });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    access_token: "rotated", refresh_token: "refresh-new", resource_url: "https://portal.qwen.ai", expires_in: 3600,
  }), { status: 200 }));
  const grant = await createGrantResolver(credentials, () => ({}))("qwen");
  assert.equal(grant.refresh, "refresh-new");
  assert.equal(grant.resourceUrl, "https://portal.qwen.ai/v1");
  assert.deepEqual(credentials.records.get(key).payload, grant);
  assert.equal(credentials.references.get(QWEN_KEY_NAME), "rotated");
});

test("Qwen observes a concurrent refresh inside the record lock without deleting it or exchanging twice", async (t) => {
  const key = "dsh-oauth/qwen";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: { access: "old", refresh: "refresh-old", expires: 1 } } });
  const modifyRecord = credentials.modifyRecord;
  const refreshed = { access: "concurrent-fresh", refresh: "concurrent-refresh", expires: Date.now() + 3600000, resourceUrl: "https://portal.qwen.ai/v1" };
  credentials.modifyRecord = async (recordKey, mutate) => {
    credentials.records.set(recordKey, { kind: "grant", payload: refreshed });
    return modifyRecord(recordKey, mutate);
  };
  t.mock.method(globalThis, "fetch", async () => { assert.fail("concurrent refresh already produced a fresh grant"); });
  const grant = await createGrantResolver(credentials, () => ({}))("qwen");
  assert.deepEqual(grant, refreshed);
  assert.deepEqual(credentials.records.get(key), { kind: "grant", payload: refreshed });
  assert.equal(credentials.references.get(QWEN_KEY_NAME), "concurrent-fresh");
});

test("Qwen disconnect inside the record lock rejects without recreating the grant or credential reference", async (t) => {
  const key = "dsh-oauth/qwen";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: { access: "old", refresh: "refresh-old", expires: 1 } } });
  const modifyRecord = credentials.modifyRecord;
  credentials.modifyRecord = async (recordKey, mutate) => {
    credentials.records.delete(recordKey);
    return modifyRecord(recordKey, mutate);
  };
  t.mock.method(globalThis, "fetch", async () => { assert.fail("a disconnected grant must not refresh"); });
  await assert.rejects(createGrantResolver(credentials, () => ({}))("qwen"), /登录已断开/);
  assert.equal(credentials.records.has(key), false);
  assert.equal(credentials.references.has(QWEN_KEY_NAME), false);
});

function refreshableModels(refresh) {
  return ({ credentials: store }) => ({
    getProvider() { return { auth: { oauth: { refresh } } }; },
    async getAuth(id) { return { auth: { apiKey: (await store.read(id))?.access } }; },
  });
}

const futureGrant = () => ({ type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() + 3600000 });

test("an explicitly rejected access token is refreshed even before its advertised expiry", async () => {
  const key = "llm-pi-ai/xai";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: futureGrant() } });
  let exchanges = 0;
  const resolveGrant = createGrantResolver(credentials, refreshableModels(async (current, signal) => {
    exchanges += 1;
    assert.ok(signal instanceof AbortSignal);
    assert.equal(current.refresh, "old-refresh");
    return { ...current, access: "new-access", refresh: "rotated-refresh" };
  }));
  const rejectedGrant = await resolveGrant("xai");
  const renewed = await resolveGrant("xai", { rejectedGrant });
  assert.equal(exchanges, 1);
  assert.equal(renewed.access, "new-access");
  assert.equal(credentials.records.get(key).payload.refresh, "rotated-refresh");
});

test("concurrent rejected requests refresh once and reuse the persisted winner", async () => {
  const key = "llm-pi-ai/xai";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: futureGrant() } });
  let exchanges = 0;
  const resolveGrant = createGrantResolver(credentials, refreshableModels(async (current) => {
    exchanges += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ...current, access: "new-access", refresh: "rotated-refresh" };
  }));
  const first = await resolveGrant("xai");
  const second = await resolveGrant("xai");
  const renewed = await Promise.all([resolveGrant("xai", { rejectedGrant: first }), resolveGrant("xai", { rejectedGrant: second })]);
  assert.equal(exchanges, 1);
  assert.deepEqual(renewed.map((grant) => grant.access), ["new-access", "new-access"]);
  assert.equal((await resolveGrant("xai", { rejectedGrant: first })).access, "new-access");
  assert.equal(exchanges, 1, "a late failure of the old request cannot rotate the new token again");
});

test("failed forced refresh preserves the entire stored grant and reports a safe retryable error", async () => {
  const key = "llm-pi-ai/xai";
  const original = futureGrant();
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: original } });
  const cause = new TypeError("mock network failure with private upstream detail");
  const resolveGrant = createGrantResolver(credentials, refreshableModels(async () => { throw cause; }));
  const rejectedGrant = await resolveGrant("xai");
  await assert.rejects(resolveGrant("xai", { rejectedGrant }), (error) => {
    assert.match(error.message, /本地授权已保留/);
    assert.ok(!error.message.includes("private upstream detail"));
    assert.equal(error.cause, cause);
    return true;
  });
  assert.deepEqual(credentials.records.get(key), { kind: "grant", payload: original });
});

test("forced refresh cannot recreate a disconnected grant or act on an unknown request snapshot", async () => {
  const key = "llm-pi-ai/xai";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: futureGrant() } });
  let exchanges = 0;
  const resolveGrant = createGrantResolver(credentials, refreshableModels(async () => { exchanges += 1; }));
  const rejectedGrant = await resolveGrant("xai");
  await assert.rejects(resolveGrant("xai", { rejectedGrant: { ...rejectedGrant } }), /无法核对/);
  await assert.rejects(resolveGrant("anthropic", { rejectedGrant }), /无法核对/);
  credentials.records.delete(key);
  await assert.rejects(resolveGrant("xai", { rejectedGrant }), /先完成/);
  assert.equal(exchanges, 0);
  assert.equal(credentials.records.has(key), false);
});

test("forced refresh compares the stored credential rather than derived request auth", async () => {
  const key = "llm-pi-ai/github-copilot";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: futureGrant() } });
  let exchanges = 0;
  const resolveGrant = createGrantResolver(credentials, ({ credentials: store }) => ({
    getProvider() { return { auth: { oauth: { async refresh(current) { exchanges += 1; return { ...current, access: "refreshed-upstream-access" }; } } } }; },
    async getAuth(id) {
      const current = await store.read(id);
      return { auth: { apiKey: `derived-${current.access}` } };
    },
  }));
  const rejectedGrant = await resolveGrant("github-copilot");
  assert.equal(rejectedGrant.access, "derived-old-access");
  const renewed = await resolveGrant("github-copilot", { rejectedGrant });
  assert.equal(exchanges, 1);
  assert.equal(renewed.access, "derived-refreshed-upstream-access");
});

test("a concurrent grant commit before request-auth derivation uses the matching new storage snapshot", async () => {
  const key = "llm-pi-ai/xai";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: futureGrant() } });
  let exchanges = 0;
  let first = true;
  const resolveGrant = createGrantResolver(credentials, () => ({
    getProvider() { return { auth: { oauth: {
      async toAuth(current) { return { apiKey: current.access }; },
      async refresh(current) { exchanges += 1; return { ...current, access: "recovered-access" }; },
    } } }; },
    async getAuth() {
      if (first) {
        first = false;
        credentials.records.set(key, { kind: "grant", payload: { ...futureGrant(), access: "concurrent-access", refresh: "concurrent-refresh" } });
        return { auth: { apiKey: "old-access" } };
      }
      return { auth: { apiKey: credentials.records.get(key).payload.access } };
    },
  }));
  const observed = await resolveGrant("xai");
  assert.equal(observed.access, "concurrent-access");
  assert.equal(observed.refresh, "concurrent-refresh");
  assert.equal((await resolveGrant("xai", { rejectedGrant: observed })).access, "recovered-access");
  assert.equal(exchanges, 1);
});

test("a Qwen catalog rejection renews a future-valid grant and updates its request reference", async (t) => {
  const key = "dsh-oauth/qwen";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: { ...futureGrant(), resourceUrl: "https://portal.qwen.ai/v1" } } });
  let exchanges = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    exchanges += 1;
    assert.equal(url, "https://chat.qwen.ai/api/v1/oauth2/token");
    assert.equal(options.body.get("refresh_token"), "old-refresh");
    return new Response(JSON.stringify({ access_token: "qwen-renewed", expires_in: 3600 }));
  });
  const resolveGrant = createGrantResolver(credentials, () => ({}));
  const observed = await resolveGrant("qwen");
  assert.equal(exchanges, 0);
  const renewed = await resolveGrant("qwen", { rejectedGrant: observed });
  assert.equal(exchanges, 1);
  assert.equal(renewed.access, "qwen-renewed");
  assert.equal(renewed.refresh, "old-refresh");
  assert.equal(credentials.references.get(QWEN_KEY_NAME), "qwen-renewed");
});

test("a disconnect while waiting for the forced-refresh lock never restores an old account", async () => {
  const key = "llm-pi-ai/xai";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: futureGrant() } });
  let exchanges = 0;
  const resolveGrant = createGrantResolver(credentials, refreshableModels(async () => { exchanges += 1; }));
  const observed = await resolveGrant("xai");
  const modify = credentials.modifyRecord;
  credentials.modifyRecord = async (recordKey, mutate) => {
    credentials.records.delete(recordKey);
    return modify(recordKey, mutate);
  };
  await assert.rejects(resolveGrant("xai", { rejectedGrant: observed }), /登录已断开/);
  assert.equal(exchanges, 0);
  assert.equal(credentials.records.has(key), false);
});

test("Kimi accepts the installed OAuth adapter's header-based authorization", async () => {
  const key = "llm-pi-ai/kimi-coding";
  const credentials = memoryCredentials({ [key]: { kind: "grant", payload: { type: "oauth", access: "fixture-kimi" } } });
  const auth = { headers: { Authorization: "Bearer fixture-kimi" } };
  const resolveGrant = createGrantResolver(credentials, () => ({
    getAuth: async () => ({ auth }),
    getProvider: () => ({ auth: { oauth: { toAuth: async () => auth } } }),
  }));
  const result = await resolveGrant("kimi-coding");
  assert.equal(result.access, "fixture-kimi");
  assert.deepEqual(result.requestHeaders, auth.headers);
});
