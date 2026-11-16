import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createAuthorizationSessions } from "./authorization.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function service(run) {
  const state = { interaction: null, signal: null, cancelCalls: 0 };
  return Object.assign(state, {
    describe: () => ({ inFlight: false }),
    cancel: () => { state.cancelCalls += 1; },
    async begin(request) {
      state.interaction = request.interaction;
      state.signal = request.signal;
      return run(request);
    },
  });
}

test("notices return the device code, URL and real eventual outcome", async () => {
  let complete;
  const upstream = service(({ interaction }) => {
    interaction.notify({ message: "Enter this code", url: "https://example.test/device", code: "ABCD-1234" });
    return new Promise((resolve) => { complete = resolve; });
  });
  const manager = createAuthorizationSessions();
  const snapshot = await manager.begin(upstream, "copilot", "key");
  assert.equal(snapshot.code, "ABCD-1234");
  assert.equal(snapshot.url, "https://example.test/device");
  assert.equal(snapshot.status, "pending");
  const duplicate = await manager.begin(upstream, "copilot", "key");
  assert.equal(duplicate.attemptId, snapshot.attemptId);
  complete({ status: "authorized" });
  await tick();
  assert.equal(manager.get("copilot").status, "authorized");
  manager.dispose();
});

test("manual prompts wait for the matching answer and never include the answer in snapshots", async () => {
  let received;
  const upstream = service(async ({ interaction }) => {
    received = await interaction.prompt({ kind: "secret", message: "Paste code" });
    return { status: "authorized" };
  });
  const manager = createAuthorizationSessions();
  const snapshot = await manager.begin(upstream, "anthropic", "key");
  assert.equal(snapshot.prompt.kind, "secret");
  assert.throws(() => manager.answer("anthropic", { attemptId: "old", promptId: snapshot.prompt.id, value: "secret-value" }), /更新/);
  assert.throws(() => manager.answer("anthropic", { attemptId: snapshot.attemptId, promptId: "old", value: "secret-value" }), /撤回/);
  manager.answer("anthropic", { attemptId: snapshot.attemptId, promptId: snapshot.prompt.id, value: "secret-value" });
  await tick();
  assert.equal(received, "secret-value");
  assert.equal(manager.get("anthropic").status, "authorized");
  assert.ok(!JSON.stringify(manager.get("anthropic")).includes("secret-value"));
  manager.dispose();
});

test("callback-winning prompt withdrawal rejects and removes only that prompt", async () => {
  const manual = new AbortController();
  let promptResult;
  let complete;
  const upstream = service(({ interaction }) => {
    promptResult = interaction.prompt({ kind: "text", message: "Paste callback", signal: manual.signal }).catch((error) => error.name);
    return new Promise((resolve) => { complete = resolve; });
  });
  const manager = createAuthorizationSessions();
  const snapshot = await manager.begin(upstream, "codex", "key");
  assert.ok(snapshot.prompt);
  manual.abort();
  assert.equal(await promptResult, "AbortError");
  assert.equal(manager.get("codex").prompt, undefined);
  assert.equal(manager.get("codex").status, "pending");
  complete({ status: "authorized" });
  await tick();
  assert.equal(manager.get("codex").status, "authorized");
  manager.dispose();
});

test("select prompts validate choices and expose queued questions in order", async () => {
  let first, second;
  const upstream = service(async ({ interaction }) => {
    const choices = interaction.prompt({ kind: "select", message: "Choose mode", options: [{ id: "browser", label: "Browser" }] });
    const code = interaction.prompt({ kind: "text", message: "Code" });
    [first, second] = await Promise.all([choices, code]);
    return { status: "authorized" };
  });
  const manager = createAuthorizationSessions();
  const snapshot = await manager.begin(upstream, "test", "key");
  assert.equal(snapshot.prompt.kind, "select");
  assert.throws(() => manager.answer("test", { attemptId: snapshot.attemptId, promptId: snapshot.prompt.id, value: "invalid" }), /选项/);
  manager.answer("test", { attemptId: snapshot.attemptId, promptId: snapshot.prompt.id, value: "browser" });
  const next = manager.get("test");
  assert.equal(next.prompt.message, "Code");
  manager.answer("test", { attemptId: next.attemptId, promptId: next.prompt.id, value: "callback-code" });
  await tick();
  assert.deepEqual([first, second], ["browser", "callback-code"]);
  manager.dispose();
});

test("cancel aborts the upstream and pending input, and stale cancel cannot touch a newer attempt", async () => {
  const upstream = service(async ({ interaction }) => {
    await interaction.prompt({ kind: "text", message: "Waiting" });
    return { status: "authorized" };
  });
  const manager = createAuthorizationSessions();
  const first = await manager.begin(upstream, "provider", "key");
  assert.equal(manager.cancel("provider", { attemptId: first.attemptId }).status, "cancelled");
  assert.equal(upstream.signal.aborted, true);
  await tick();
  const second = await manager.begin(upstream, "provider", "key");
  assert.notEqual(first.attemptId, second.attemptId);
  assert.throws(() => manager.cancel("provider", { attemptId: first.attemptId }), /更新/);
  assert.equal(manager.get("provider").status, "pending");
  manager.dispose();
  await tick();
  assert.equal(upstream.signal.aborted, true);
  assert.equal(manager.get("provider"), undefined);
});

test("upstream failures and timeout remain errors, while no first notice still returns pending", async () => {
  const manager = createAuthorizationSessions({ readyTimeoutMs: 5, attemptTimeoutMs: 25 });
  const upstream = service(() => new Promise(() => {}));
  const pending = await manager.begin(upstream, "silent", "key");
  assert.equal(pending.status, "pending");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(manager.get("silent").status, "error");
  assert.match(manager.get("silent").error, /超时/);
  assert.equal(upstream.signal.aborted, true);
  const failing = service(() => { throw new Error("provider unavailable"); });
  assert.equal((await manager.begin(failing, "failed", "key2")).error, "provider unavailable");
  manager.dispose();
});

test("unsafe notice URL is discarded and an external in-flight attempt is not invented", async () => {
  const manager = createAuthorizationSessions();
  const upstream = service(({ interaction }) => {
    interaction.notify({ message: "Bad URL", url: "javascript:alert(1)" });
    return new Promise(() => {});
  });
  assert.equal((await manager.begin(upstream, "badurl", "key")).url, "");
  const other = { describe: () => ({ inFlight: true }) };
  await assert.rejects(manager.begin(other, "other", "otherkey"), /其他窗口/);
  manager.dispose();
});

test("accepted browser callback is allowed to finish saving despite a late cancel", async () => {
  let complete;
  const upstream = service(({ interaction }) => {
    interaction.notify({ url: "https://auth.example.test/authorize" });
    return new Promise((resolve) => { complete = resolve; });
  });
  upstream.isCommitting = () => true;
  const manager = createAuthorizationSessions();
  const started = await manager.begin(upstream, "xai", "key");
  assert.equal(manager.cancel("xai", { attemptId: started.attemptId }).status, "pending");
  assert.equal(upstream.signal.aborted, false);
  assert.equal(upstream.cancelCalls, 0);
  complete({ status: "authorized" });
  await tick();
  assert.equal(manager.get("xai").status, "authorized");
  manager.dispose();
});

test("logout clear still invalidates a browser attempt while its callback is being saved", async () => {
  let complete;
  const upstream = service(({ interaction }) => {
    interaction.notify({ url: "https://auth.example.test/authorize" });
    return new Promise((resolve) => { complete = resolve; });
  });
  upstream.isCommitting = () => true;
  const manager = createAuthorizationSessions();
  await manager.begin(upstream, "xai", "key");
  manager.clear("xai");
  assert.equal(upstream.signal.aborted, true);
  assert.equal(upstream.cancelCalls, 1);
  complete({ status: "authorized" });
  await tick();
  assert.equal(manager.get("xai"), undefined);
});

test("an accepted callback has bounded extra time to complete rather than being lost at the waiting deadline", async () => {
  let complete;
  const upstream = service(({ interaction }) => {
    interaction.notify({ url: "https://auth.example.test/authorize" });
    return new Promise((resolve) => { complete = resolve; });
  });
  upstream.isCommitting = () => true;
  const manager = createAuthorizationSessions({ attemptTimeoutMs: 10, commitGraceMs: 30 });
  await manager.begin(upstream, "xai", "key");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.get("xai").status, "pending");
  assert.equal(upstream.signal.aborted, false);
  complete({ status: "authorized" });
  await tick();
  assert.equal(manager.get("xai").status, "authorized");
  manager.dispose();
});

// The panel tests use a minimal DOM to exercise state and network boundaries
// without an installed browser, a real provider or any credentials.
async function panelHarness({ path = "/oauth", fetcher, popupBlocked = false } = {}) {
  const elements = new Map();
  class Element {
    constructor() { this.hidden = false; this.value = ""; this.dataset = {}; this.isConnected = true; this.events = {}; this.children = new Map(); this.attributes = new Map(); this._html = ""; }
    addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    focus() { document.activeElement = this; }
    contains(node) { return node === this || [...this.children.values()].includes(node); }
    append(node) { this.children.set(`child-${this.children.size}`, node); }
    set innerHTML(value) {
      this._html = value;
      this.children = new Map();
      for (const match of value.matchAll(/<(input|select|button|div)\b([^>]*)>/g)) {
        const child = new Element();
        child.dataset.promptId = /data-prompt-id="([^"]*)"/.exec(match[2])?.[1];
        const id = /\bid="([^"]+)"/.exec(match[2])?.[1];
        const classes = /\bclass="([^"]+)"/.exec(match[2])?.[1]?.split(/\s+/) || [];
        if (id) { child.id = id; this.children.set(`#${id}`, child); }
        if (classes.includes("dialog")) this.children.set(".dialog", child);
        if (!this.children.has(match[1])) this.children.set(match[1], child);
      }
    }
    get innerHTML() { return this._html; }
    querySelector(id) { return this.children.get(id) || null; }
    querySelectorAll(selector) {
      if (selector === "input, select") return [...new Set([...this.children.values()])].filter((child) => child.id?.startsWith("authorization-"));
      return [];
    }
  }
  for (const id of ["#count", "#rows", "#refresh", "#reset", "#modal", "#toast", ".lead", "#locale", "#page-kicker", "#page-title", "#providers-title"]) elements.set(id, new Element());
  elements.get("#modal").hidden = true;
  const document = {
    documentElement: new Element(), activeElement: null,
    createElement() { return new Element(); },
    getElementById(id) { return this.querySelector(`#${id}`); },
    querySelector(id) { return elements.get(id) || elements.get("#modal").querySelector(id.replace(/^#modal /, "")); },
    querySelectorAll(selector) { return selector === ".nav button" ? [] : elements.get("#modal").querySelectorAll(selector); },
    addEventListener() {},
  };
  const events = {};
  const timers = new Map();
  const calls = [];
  let sequence = 0;
  const popup = { closed: false, close() { this.closed = true; }, location: { replace(url) { calls.push(["navigate", url]); } } };
  const window = {
    addEventListener(type, handler) { events[type] = handler; },
    open(url) { calls.push(["open", url]); return popupBlocked ? null : popup; },
    setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { timers.set(++sequence, fn); return sequence; }, clearInterval(id) { timers.delete(id); },
    DshOAuth: { loginOpener: () => null, runAuthorizeHooks: async () => true },
  };
  const localStorage = { getItem: () => null, setItem(key, value) { calls.push(["store", key, value]); } };
  const navigator = { sendBeacon(url, body) { calls.push(["beacon", url, body]); return true; } };
  const context = vm.createContext({ window, document, location: new URL(`http://panel.test${path}`), localStorage, navigator, URL, Blob,
    fetch: async (url, options) => { calls.push(["fetch", url, options]); return fetcher(url, options); },
  });
  vm.runInContext('const PROVIDERS = [{ id: "anthropic", name: "Claude", cli: "dsh oauth login anthropic" }]; const FLOW_LABEL = {};', context);
  vm.runInContext(await readFile(new URL("../app.js", import.meta.url), "utf8"), context);
  await tick();
  return { context, calls, events, elements, popup, evaluate: (source) => vm.runInContext(source, context) };
}
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });
const providersResponse = () => response({ providers: [{ id: "anthropic", name: "Claude", loggedIn: false }] });

test("hosted panel opens the popup before requesting login and displays the real device code", async () => {
  const panel = await panelHarness({ fetcher: (url) => url.endsWith("providers") ? providersResponse() : response({ attemptId: "attempt", status: "pending", url: "https://example.test/auth", code: "ABCD", prompt: { id: "prompt", kind: "text", message: "Paste code" } }) });
  await panel.evaluate("openLogin('anthropic')");
  const openIndex = panel.calls.findIndex((call) => call[0] === "open");
  const loginIndex = panel.calls.findIndex((call) => call[1] === "/oauth/api/login");
  assert.ok(openIndex >= 0 && openIndex < loginIndex);
  assert.ok(!panel.calls[openIndex][1].includes("preview=1"));
  assert.match(panel.elements.get("#modal").innerHTML, /ABCD/);
  assert.match(panel.elements.get("#modal").innerHTML, /Paste code/);
  assert.ok(panel.calls.some((call) => call[0] === "navigate" && call[1] === "https://example.test/auth"));
  panel.events.pagehide();
  const beacon = panel.calls.find((call) => call[0] === "beacon");
  assert.equal(beacon[1], "/oauth/api/login/cancel");
  assert.deepEqual(JSON.parse(await beacon[2].text()), { provider: "anthropic", attemptId: "attempt" });
});

test("formal API failure cannot create a preview connection or react to simulated success", async () => {
  const panel = await panelHarness({ fetcher: (url) => url.endsWith("providers") ? providersResponse() : response({ error: "upstream offline" }, false) });
  await panel.evaluate("openLogin('anthropic')");
  assert.match(panel.elements.get("#modal").innerHTML, /upstream offline/);
  assert.equal(panel.evaluate("status.anthropic.loggedIn"), false);
  await panel.events.message({ origin: "http://panel.test", source: panel.popup, data: { type: "dsh-oauth-preview", provider: "anthropic", ok: true } });
  assert.equal(panel.evaluate("status.anthropic.loggedIn"), false);
  assert.equal(panel.calls.filter((call) => call[0] === "open").length, 1);
  assert.ok(!panel.calls.some((call) => call[0] === "store"));
});

test("no URL and a blocked popup keep the real attempt pending with manual input", async () => {
  const panel = await panelHarness({ popupBlocked: true, fetcher: (url) => url.endsWith("providers") ? providersResponse() : response({ attemptId: "attempt", status: "pending", url: "", prompt: { id: "prompt", kind: "text", message: "Paste authorization code" } }) });
  await panel.evaluate("openLogin('anthropic')");
  assert.match(panel.elements.get("#modal").innerHTML, /Paste authorization code/);
  assert.match(panel.elements.get("#modal").innerHTML, /拦截/);
  assert.equal(panel.evaluate("activeLogin.snapshot.status"), "pending");
  assert.equal(panel.calls.filter((call) => call[0] === "open").length, 1);
});

test("static preview is explicit and does not probe the OAuth API", async () => {
  const panel = await panelHarness({ path: "/index.html", fetcher: () => { throw new Error("must not fetch"); } });
  assert.match(panel.elements.get("#count").textContent, /静态示例/);
  await panel.evaluate("openLogin('anthropic')");
  assert.ok(panel.calls.find((call) => call[0] === "open")[1].includes("preview=1"));
  assert.ok(!panel.calls.some((call) => call[0] === "fetch"));
  await panel.events.message({ origin: "http://panel.test", source: panel.popup, data: { type: "dsh-oauth-preview", provider: "anthropic", ok: true } });
  assert.equal(panel.evaluate("status.anthropic.sourceLabel"), "静态预览");
});


test("manual answer is sent with attempt/prompt identity and cancellation reflects the server outcome", async () => {
  const panel = await panelHarness({ fetcher: (url) => {
    if (url.endsWith("providers")) return providersResponse();
    if (url.endsWith("cancel")) return response({ attemptId: "attempt", status: "cancelled" });
    if (url.endsWith("answer")) return response({ attemptId: "attempt", status: "pending" });
    return response({ attemptId: "attempt", status: "pending", prompt: { id: "prompt", kind: "secret", message: "Paste code" } });
  } });
  await panel.evaluate("openLogin('anthropic')");
  panel.elements.get("#modal").querySelector("#authorization-answer").value = "mock-callback";
  await panel.evaluate('submitAuthorization({target:{id:"authorization-form"},preventDefault(){}})');
  const submitted = panel.calls.find((call) => call[1] === "/oauth/api/login/answer");
  assert.deepEqual(JSON.parse(submitted[2].body), { provider: "anthropic", attemptId: "attempt", promptId: "prompt", value: "mock-callback" });
  assert.ok(!panel.calls.some((call) => call[0] === "store"));
  await panel.evaluate("cancelAuthorization()");
  assert.match(panel.elements.get("#modal").innerHTML, /已取消/);
  assert.equal(panel.evaluate("pendingId"), null);
  assert.equal(panel.popup.closed, true);
});
