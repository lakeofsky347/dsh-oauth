import assert from "node:assert/strict";
import test from "node:test";
import { createXaiBrowserAuthorization } from "./xai-login.js";

const KEY = "llm-pi-ai/xai";
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const grant = { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 10000000000000 };

function fixture(initial) {
  const listeners = new Set();
  let record = clone(initial);
  let queue = Promise.resolve();
  const state = { hostInFlight: false, writes: 0, modifies: 0, beforePersist: undefined };
  const publish = () => { for (const listener of listeners) listener(KEY); };
  const enqueue = (operation) => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  const credentials = {
    async readRecord(key) { assert.equal(key, KEY); return clone(record); },
    async modifyRecord(key, mutate) {
      assert.equal(key, KEY);
      state.modifies += 1;
      return enqueue(async () => {
        const next = await mutate(clone(record));
        if (next !== undefined) {
          await state.beforePersist?.();
          record = clone(next);
          state.writes += 1;
          publish();
        }
        return clone(record);
      });
    },
    async deleteRecord(key) {
      assert.equal(key, KEY);
      return enqueue(async () => { record = undefined; publish(); });
    },
  };
  return {
    state, credentials, listeners,
    ctx: { credentials, on(event, listener) { assert.equal(event, "credentials/record-updated"); listeners.add(listener); return () => listeners.delete(listener); } },
    authorization: { describe(key) { assert.equal(key, KEY); return { key, inFlight: state.hostInFlight }; } },
    get record() { return clone(record); },
    replace(next) { record = clone(next); publish(); },
    replaceWithoutEvent(next) { record = clone(next); },
  };
}

function controlledLogin() {
  let resolve;
  const result = new Promise((done) => { resolve = done; });
  let entered;
  const started = new Promise((done) => { entered = done; });
  const state = { interaction: undefined, calls: 0 };
  return {
    state, started, finish: (value = grant) => resolve(value),
    login: async (interaction) => { state.calls += 1; state.interaction = interaction; entered(); return result; },
  };
}

const request = (signal) => ({ key: KEY, method: "oauth", interaction: { notify() {}, async prompt() { return "unused"; } }, signal });

test("browser authorization commits only the canonical record and reports success after persistence", async () => {
  const f = fixture();
  const login = controlledLogin();
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: login.login });
  const run = adapter.begin(request());
  await login.started;
  assert.equal(f.state.modifies, 0, "the record lock is not held while waiting for browser approval");
  assert.equal(adapter.describe(KEY).inFlight, true);
  assert.equal(adapter.isCommitting(KEY), false);
  login.state.interaction.onExchangeStart();
  assert.equal(adapter.isCommitting(KEY), true);
  login.finish();
  assert.deepEqual(await run, { status: "authorized" });
  assert.deepEqual(f.record, { kind: "grant", payload: grant });
  assert.equal(f.state.writes, 1);
  assert.equal(adapter.describe(KEY).inFlight, false);
  assert.equal(adapter.isCommitting(KEY), false);
  adapter.dispose();
});

test("native device login and a second browser attempt are rejected before another browser login starts", async () => {
  const f = fixture();
  const login = controlledLogin();
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: login.login });
  f.state.hostInFlight = true;
  await assert.rejects(adapter.begin(request()), /登录正在进行/);
  assert.equal(login.state.calls, 0);
  f.state.hostInFlight = false;
  const run = adapter.begin(request());
  await login.started;
  await assert.rejects(adapter.begin(request()), /登录正在进行/);
  assert.equal(login.state.calls, 1);
  adapter.cancel(KEY);
  login.finish();
  assert.deepEqual(await run, { status: "cancelled" });
  assert.equal(f.record, undefined);
  adapter.dispose();
});

test("a native device attempt that starts while the browser waits prevents canonical commit", async () => {
  const f = fixture();
  const login = controlledLogin();
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: login.login });
  const run = adapter.begin(request());
  await login.started;
  f.state.hostInFlight = true;
  login.finish();
  await assert.rejects(run, /其他窗口登录/);
  assert.equal(f.state.writes, 0);
  adapter.dispose();
});

test("the native device guard is repeated after the DSH record lock is acquired", async () => {
  const f = fixture();
  const originalModify = f.credentials.modifyRecord;
  f.credentials.modifyRecord = (key, mutate) => {
    f.state.hostInFlight = true;
    return originalModify(key, mutate);
  };
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: async () => grant });
  await assert.rejects(adapter.begin(request()), /其他窗口登录/);
  assert.equal(f.state.modifies, 1);
  assert.equal(f.state.writes, 0);
  assert.equal(f.record, undefined);
  adapter.dispose();
});

test("a credential change without a local event is still rejected by the compare-and-swap under the DSH lock", async () => {
  const before = { kind: "grant", payload: { ...grant, access: "initial" } };
  const winner = { kind: "grant", payload: { ...grant, access: "other-process" } };
  const f = fixture(before);
  const login = controlledLogin();
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: login.login });
  const run = adapter.begin(request());
  await login.started;
  f.replaceWithoutEvent(winner);
  login.finish();
  await assert.rejects(run, /凭据在登录期间已更改/);
  assert.deepEqual(f.record, winner);
  assert.equal(f.state.writes, 0);
  adapter.dispose();
});

test("local credential ABA changes invalidate a browser attempt even when the final record equals its start snapshot", async () => {
  const before = { kind: "grant", payload: { ...grant, access: "initial" } };
  const f = fixture(before);
  const login = controlledLogin();
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: login.login });
  const run = adapter.begin(request());
  await login.started;
  f.replace(undefined);
  f.replace(before);
  login.finish();
  await assert.rejects(run, /凭据在登录期间已更改/);
  assert.deepEqual(f.record, before);
  assert.equal(f.state.writes, 0);
  adapter.dispose();
});

test("logout during an already-started token exchange invalidates its late result before any credential write", async () => {
  const f = fixture({ kind: "grant", payload: { ...grant, access: "prior" } });
  const login = controlledLogin();
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: login.login });
  const controller = new AbortController();
  const run = adapter.begin(request(controller.signal));
  await login.started;
  login.state.interaction.onExchangeStart();
  assert.equal(adapter.isCommitting(KEY), true);
  controller.abort();
  adapter.cancel(KEY);
  await f.credentials.deleteRecord(KEY);
  login.finish();
  assert.deepEqual(await run, { status: "cancelled" });
  assert.equal(f.record, undefined);
  assert.equal(f.state.writes, 0);
  adapter.dispose();
});

test("logout queued after commit starts wins the DSH write ordering and no late result recreates the grant", async () => {
  const f = fixture();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const committing = new Promise((resolve) => { entered = resolve; });
  f.state.beforePersist = async () => { entered(); await held; };
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: async (interaction) => { interaction.onExchangeStart(); return grant; } });
  const controller = new AbortController();
  const run = adapter.begin(request(controller.signal));
  await committing;
  assert.equal(adapter.isCommitting(KEY), true);
  controller.abort();
  adapter.cancel(KEY);
  const deleted = f.credentials.deleteRecord(KEY);
  release();
  assert.deepEqual(await run, { status: "cancelled" });
  await deleted;
  await tick();
  assert.equal(f.record, undefined);
  assert.equal(f.state.writes, 1);
  adapter.dispose();
});

test("a cancelled browser attempt cannot commit after a newer browser attempt succeeds", async () => {
  const f = fixture();
  const first = controlledLogin();
  const second = controlledLogin();
  let calls = 0;
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: (interaction) => (++calls === 1 ? first : second).login(interaction) });
  const stale = adapter.begin(request());
  await first.started;
  adapter.cancel(KEY);
  const current = adapter.begin(request());
  await second.started;
  const winner = { ...grant, access: "new-attempt" };
  second.state.interaction.onExchangeStart();
  second.finish(winner);
  assert.deepEqual(await current, { status: "authorized" });
  first.finish({ ...grant, access: "late-old-attempt" });
  assert.deepEqual(await stale, { status: "cancelled" });
  assert.deepEqual(f.record, { kind: "grant", payload: winner });
  assert.equal(f.state.writes, 1);
  adapter.dispose();
});

test("disposing the adapter removes its credential listener and prevents an ignored-abort login from writing", async () => {
  const f = fixture();
  const login = controlledLogin();
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: login.login });
  const run = adapter.begin(request());
  await login.started;
  assert.equal(f.listeners.size, 1);
  adapter.dispose();
  adapter.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(login.state.interaction.signal.aborted, true);
  login.finish();
  assert.deepEqual(await run, { status: "cancelled" });
  assert.equal(f.state.writes, 0);
  await assert.rejects(adapter.begin(request()), /已卸载/);
});

test("wrong keys, unsupported methods, and pre-aborted requests never invoke browser login", async () => {
  const f = fixture();
  let calls = 0;
  const adapter = createXaiBrowserAuthorization(f.ctx, f.authorization, { login: async () => { calls += 1; return grant; } });
  await assert.rejects(adapter.begin({ ...request(), key: "dsh-oauth/xai-browser" }), /仅支持 xAI/);
  await assert.rejects(adapter.begin({ ...request(), method: "device" }), /不支持该登录方式/);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await adapter.begin(request(controller.signal)), { status: "cancelled" });
  assert.equal(adapter.describe("unrelated"), undefined);
  assert.equal(calls, 0);
  adapter.dispose();
});
