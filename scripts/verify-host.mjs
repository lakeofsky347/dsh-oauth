#!/usr/bin/env node
/** Offline integration against real published DSH packages; no live profile or account is used. */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeArg = process.argv.indexOf("--runtime");
const runtime = runtimeArg < 0 ? root : resolve(process.argv[runtimeArg + 1] ?? "");
const modules = runtime.endsWith("node_modules") ? runtime : join(runtime, "node_modules");
const temporary = await mkdtemp(join(tmpdir(), "dsh-oauth-host-smoke-"));
const previousHome = process.env.DSH_HOME;
const previousFetch = globalThis.fetch;
let ctx;
try {
  process.env.DSH_HOME = join(temporary, "profile");
  const pluginRoot = join(temporary, "plugin");
  for (const path of ["src", "package.json", "client.js", "index.html", "auth.html", "app.js", "providers.js", "styles.css", "theme.js"]) {
    await cp(join(root, path), join(pluginRoot, path), { recursive: true });
  }
  await symlink(modules, join(pluginRoot, "node_modules"), "dir");
  const requireRuntime = createRequire(join(pluginRoot, "package.json"));
  const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href);
  const [{ Context, Service }, credentialsModule, authorizationModule, toolsModule, systemPromptModule, slotsModule] = await Promise.all([
    load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-credentials"), load("@deepseek-ai/dsh-authorization"),
    load("@deepseek-ai/dsh-tools"), load("@deepseek-ai/dsh-system-prompt"), load("@deepseek-ai/dsh-client-ui-slots"),
  ]);
  // Loading these official exports catches package/import drift even though settings are held in memory below.
  await Promise.all([load("@deepseek-ai/dsh-settings"), load("@deepseek-ai/dsh-client-ui-settings"), load("@deepseek-ai/dsh-client-ui-settings-general")]);
  const piAiAdapter = await load("@deepseek-ai/dsh-llm-pi-ai");
  const { credentialKey, CredentialProvider } = credentialsModule;
  const routes = [];
  const mutations = [];
  const references = new Map();
  const records = new Map();
  let userSettings = { providers: {} };
  let revision = 0;
  let deepseekCounter = 0;
  let commitDuringCancel = false;
  const deepseekCancels = [];
  let deepseekState = { status: "signed-out", attempt: null };
  let pauseQwenRecord;
  let pauseQwenReference;
  class MemoryCredentials extends CredentialProvider {
    async resolve(ref) { const value = references.get(ref); return value === undefined ? undefined : { value, source: "memory" }; }
    async describe(ref) { return { configured: references.has(ref), writable: true }; }
    async set(ref, value) {
      if (ref === "QWEN_OAUTH_ACCESS" && pauseQwenReference) {
        const pause = pauseQwenReference;
        pauseQwenReference = undefined;
        pause.enter();
        await pause.wait;
      }
      references.set(ref, value); this.notifyUpdated(ref);
    }
    async unset(ref) { references.delete(ref); this.notifyUpdated(ref); }
    async readRecord(key) { return records.get(key); }
    async describeRecord(key) { const value = records.get(key); return { configured: value !== undefined, writable: true, ...(value === undefined ? {} : { kind: value.kind }) }; }
    async listRecords() { return [...records].map(([key, record]) => ({ key, kind: record.kind })); }
    async modifyRecord(key, mutate) {
      if (key === credentialKey("dsh-oauth", "qwen") && pauseQwenRecord) {
        const pause = pauseQwenRecord;
        pauseQwenRecord = undefined;
        pause.enter();
        await pause.wait;
      }
      const next = await mutate(records.get(key));
      if (next !== undefined) { records.set(key, next); this.notifyRecordUpdated(key); }
      return records.get(key);
    }
    async deleteRecord(key) { records.delete(key); this.notifyRecordUpdated(key); }
  }
  class MemorySettings extends Service {
    constructor(context) { super(context, "settings"); }
    describe() { return [{ ns: "llm-pi-ai", user: structuredClone(userSettings), value: structuredClone(userSettings), revision }]; }
    async mutate(namespace, operations, expectedRevision) {
      assert.equal(namespace, "llm-pi-ai");
      assert.equal(expectedRevision, revision);
      const next = structuredClone(userSettings);
      for (const operation of operations) {
        let object = next;
        for (const key of operation.path.slice(0, -1)) object = object[key] ??= {};
        const key = operation.path.at(-1);
        if (operation.op === "unset") delete object[key]; else object[key] = structuredClone(operation.value);
      }
      // Parse the actual output through the selected published adapter's schema before accepting the edit.
      piAiAdapter.Config(next);
      userSettings = next;
      revision += 1;
      mutations.push({ namespace, operations });
    }
  }
  class MemoryWebServer extends Service {
    constructor(context) { super(context, "webServer"); }
    register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1); }; }
  }
  class MemoryDeepSeekAccount extends Service {
    constructor(context) { super(context, "deepseekAccount"); }
    async getState() { return structuredClone(deepseekState); }
    async startSignIn(client, origin, source) {
      assert.equal(typeof client.version, "string");
      assert.equal(typeof client.timezoneOffsetSeconds, "number");
      assert.equal(origin, "http://127.0.0.1:19387");
      assert.equal(source, "desktop");
      deepseekCounter += 1;
      deepseekState = { status: "signed-out", attempt: { id: `deepseek-attempt-${deepseekCounter}`, phase: "waiting-browser", authorizeUrl: `https://example.invalid/deepseek/${deepseekCounter}` } };
      return this.getState();
    }
    async cancelSignIn(id) {
      assert.equal(id, deepseekState.attempt.id);
      deepseekCancels.push(id);
      deepseekState.attempt.phase = commitDuringCancel ? "succeeded" : "cancelled";
      if (commitDuringCancel) deepseekState.status = "credential-stored";
      return this.getState();
    }
  }
  ctx = new Context();
  const profileDirectory = join(process.env.DSH_HOME, "profiles", "desktop");
  ctx.provide("profileContext", { name: "desktop", dir: profileDirectory, home: process.env.DSH_HOME, patchPath: join(profileDirectory, "cordis.patch.yml") });
  await ctx.plugin(MemoryCredentials);
  await ctx.plugin(MemorySettings);
  await ctx.plugin(MemoryWebServer);
  await ctx.plugin(MemoryDeepSeekAccount);
  await ctx.plugin(systemPromptModule.default);
  await ctx.plugin(toolsModule.default);
  if (typeof ctx.tools.setExecutor === 'function') ctx.tools.setExecutor({
    sections: [],
    describe(definitions) { return { schemas: ctx.tools.schemas(), knownNames: definitions.map(tool => tool.name) }; },
    async execute() { throw new Error('Host smoke must not execute tools.'); },
  });
  const host = await import(pathToFileURL(join(pluginRoot, "src/index.js")).href);
  const fiber = ctx.plugin(host);
  await fiber;
  const route = routes.find((entry) => entry.path === "/oauth");
  assert.ok(route, "the host mounts /oauth through the real Cordis injection lifecycle");
  const request = async (path, body) => {
    const response = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = String(body ?? ""); } };
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: body === undefined ? "GET" : "POST", url: path, headers: { host: "127.0.0.1:19387" } });
    await route.handler(req, response);
    return response;
  };
  assert.equal((await request("/oauth/")).status, 200);
  const listed = await request("/oauth/api/providers");
  assert.equal(listed.status, 200);
  assert.equal(JSON.parse(listed.body).version, JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8")).version);
  assert.ok(JSON.parse(listed.body).providers.some((provider) => provider.id === "qwen"));
  const deepseekFirst = JSON.parse((await request("/oauth/api/login", { provider: "deepseek-account" })).body);
  assert.equal(deepseekFirst.pending, true);
  assert.equal(deepseekFirst.url, "https://example.invalid/deepseek/1");
  const deepseekSecond = JSON.parse((await request("/oauth/api/login", { provider: "deepseek-account" })).body);
  const staleCancel = await request("/oauth/api/login/cancel", { provider: "deepseek-account", attemptId: deepseekFirst.attemptId });
  assert.equal(staleCancel.status, 400);
  assert.equal(deepseekCancels.length, 0, "a stale panel attempt cannot cancel the current upstream attempt");
  const activeCancel = await request("/oauth/api/login/cancel", { provider: "deepseek-account", attemptId: deepseekSecond.attemptId });
  assert.equal(activeCancel.status, 200, activeCancel.body);
  assert.equal(JSON.parse(activeCancel.body).status, "cancelled");
  assert.deepEqual(deepseekCancels, ["deepseek-attempt-2"]);
  const deepseekThird = JSON.parse((await request("/oauth/api/login", { provider: "deepseek-account" })).body);
  commitDuringCancel = true;
  const committedCancel = await request("/oauth/api/login/cancel", { provider: "deepseek-account", attemptId: deepseekThird.attemptId });
  assert.equal(committedCancel.status, 200, committedCancel.body);
  assert.equal(JSON.parse(committedCancel.body).status, "authorized", "an upstream commit that beats cancellation remains authorized");
  assert.deepEqual(deepseekCancels, ["deepseek-attempt-2", "deepseek-attempt-3"]);
  assert.ok(ctx.authorization instanceof authorizationModule.AuthorizationService);
  const key = credentialKey("dsh-oauth", "qwen");
  assert.ok(ctx.authorization.describe(key), "the Qwen flow is registered on the actual AuthorizationService");
  let networkCalls = 0;
  globalThis.fetch = async (url, options) => {
    networkCalls += 1;
    assert.equal(options.method, "POST");
    const path = String(url);
    if (path === "https://chat.qwen.ai/api/v1/oauth2/device/code") {
      assert.ok(options.body.get("code_challenge"));
      return new Response(JSON.stringify({ verification_uri_complete: "https://example.invalid/verify", device_code: "offline-device", user_code: "OFFLINE-CODE", expires_in: 30 }));
    }
    assert.equal(path, "https://chat.qwen.ai/api/v1/oauth2/token", "unexpected external request is refused");
    assert.equal(options.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    return new Response(JSON.stringify({ access_token: "offline-access", refresh_token: "offline-refresh", expires_in: 3600, resource_url: "https://portal.qwen.ai" }));
  };
  const notices = [];
  const outcome = await ctx.authorization.begin({ key, interaction: { notify: (notice) => notices.push(notice), prompt: async () => { throw new Error("unexpected prompt"); } } });
  assert.deepEqual(outcome, { status: "authorized" });
  assert.equal(networkCalls, 2);
  assert.equal(records.get(key)?.payload.access, "offline-access");
  assert.equal(references.get("QWEN_OAUTH_ACCESS"), "offline-access");
  assert.equal(notices[0]?.url, "https://example.invalid/verify");
  assert.equal(notices[0]?.code, "OFFLINE-CODE");
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://portal.qwen.ai/v1/models");
    assert.equal(options.headers.authorization, "Bearer offline-access");
    return new Response(JSON.stringify({ data: [{ id: "qwen-offline", name: "Offline Qwen", context_window: 65536, max_output_tokens: 4096, input_modalities: ["text"], reasoning_efforts: [] }] }));
  };
  const pulled = await request("/oauth/api/pull", { provider: "qwen", models: ["qwen-offline"], expiresAt: Date.now() + 3600000 });
  assert.equal(pulled.status, 200, pulled.body);
  const savedModel = userSettings.providers.qwen.models[0];
  assert.equal(savedModel.contextWindow, 65536);
  assert.equal(savedModel.maxTokens, 4096);
  assert.deepEqual(savedModel.input, ["text"]);
  assert.equal(savedModel.reasoningEfforts, false);
  assert.equal(userSettings.providers.qwen.apiKeyEnv, "QWEN_OAUTH_ACCESS");
  assert.equal(mutations.length, 1);
  const pullFile = JSON.parse(await readFile(join(profileDirectory, "dsh-oauth-pulls.json"), "utf8"));
  assert.equal(pullFile.pulls.qwen.models[0].id, "qwen-offline");
  const loggedOut = await request("/oauth/api/logout", { provider: "qwen" });
  assert.equal(loggedOut.status, 200, loggedOut.body);
  assert.equal(userSettings.providers.qwen, undefined, "logout restores the previous settings through the adapter schema");

  for (const phase of ["record", "reference"]) {
    let enter;
    let release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const wait = new Promise((resolve) => { release = resolve; });
    if (phase === "record") pauseQwenRecord = { enter, wait };
    else pauseQwenReference = { enter, wait };
    globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("/device/code")
      ? { verification_uri: "https://example.invalid/qwen", device_code: "offline-device", expires_in: 30 }
      : { access_token: `offline-delayed-${phase}`, refresh_token: "offline-refresh", expires_in: 3600 }));
    const pending = await request("/oauth/api/login", { provider: "qwen" });
    assert.equal(pending.status, 200, pending.body);
    await entered;
    const disconnecting = request("/oauth/api/logout", { provider: "qwen" });
    // Let the HTTP handler cancel the flow and queue cleanup behind its in-flight write.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const disconnected = await disconnecting;
    assert.equal(disconnected.status, 200, disconnected.body);
    assert.equal(records.has(key), false, `disconnect wins after a delayed Qwen ${phase} write`);
    assert.equal(references.has("QWEN_OAUTH_ACCESS"), false, `a delayed Qwen ${phase} write cannot recreate the access reference`);
  }
  const replacement = await ctx.authorization.begin({ key, interaction: { notify() {}, prompt: async () => { throw new Error("unexpected prompt"); } } });
  assert.equal(replacement.status, "authorized");
  assert.equal(records.get(key).payload.access, "offline-delayed-reference", "a subsequent legitimate Qwen login is preserved");
  assert.equal(references.get("QWEN_OAUTH_ACCESS"), "offline-delayed-reference");
  assert.equal((await request("/oauth/api/logout", { provider: "qwen" })).status, 200);

  const xaiKey = credentialKey("llm-pi-ai", "xai");
  const removeXaiFlow = ctx.authorization.registerFlow({
    key: xaiKey, label: "Offline xAI", methods: [{ id: "oauth", label: "Device" }],
    async run(session) {
      session.notify({ url: "https://example.invalid/xai-device", code: "OFFLINE-DEVICE" });
      await new Promise((_, reject) => session.signal.addEventListener("abort", () => reject(new Error("offline device cancelled")), { once: true }));
    },
  });
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  let browserAuthorize;
  let browserExchanges = 0;
  const clientId = "b1a00492-073a-47ea-816f-4c329264a828";
  globalThis.fetch = async (url, options) => {
    if (String(url) === "https://auth.x.ai/.well-known/openid-configuration") return new Response(JSON.stringify({
      issuer: "https://auth.x.ai", authorization_endpoint: "https://auth.x.ai/oauth2/authorize", token_endpoint: "https://auth.x.ai/oauth2/token",
      jwks_uri: "https://auth.x.ai/.well-known/jwks.json", code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["ES256"],
    }));
    if (String(url) === "https://auth.x.ai/.well-known/jwks.json") return new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "offline-host-key", alg: "ES256", use: "sig" }] }));
    assert.equal(String(url), "https://auth.x.ai/oauth2/token");
    browserExchanges += 1;
    assert.equal(options.body.get("grant_type"), "authorization_code");
    assert.equal(options.body.get("client_id"), clientId);
    assert.equal(options.body.get("redirect_uri"), browserAuthorize.searchParams.get("redirect_uri"));
    assert.equal(createHash("sha256").update(options.body.get("code_verifier")).digest("base64url"), browserAuthorize.searchParams.get("code_challenge"));
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "offline-host-key" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: "https://auth.x.ai", aud: clientId, sub: "offline-host-user", exp: Math.floor(Date.now() / 1000) + 3600, nonce: browserAuthorize.searchParams.get("nonce") })).toString("base64url");
    const input = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return new Response(JSON.stringify({ access_token: "offline-browser-access", refresh_token: "offline-browser-refresh", expires_in: 3600, id_token: `${input}.${signature}` }));
  };
  const browserStarted = JSON.parse((await request("/oauth/api/login", { provider: "xai" })).body);
  browserAuthorize = new URL(browserStarted.url);
  assert.equal(browserAuthorize.pathname, "/oauth2/authorize", "the default xAI panel route must avoid device approval");
  assert.equal(browserAuthorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(browserAuthorize.searchParams.get("scope"), "openid profile email offline_access grok-cli:access api:access");
  assert.equal(browserExchanges, 0);
  const duplicateBrowser = JSON.parse((await request("/oauth/api/login", { provider: "xai", method: "browser" })).body);
  assert.equal(duplicateBrowser.attemptId, browserStarted.attemptId);
  const prematureDevice = await request("/oauth/api/login", { provider: "xai", method: "device" });
  assert.equal(prematureDevice.status, 400, "the panel cannot switch methods while a browser login is pending");
  const callback = new URL(browserAuthorize.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", browserAuthorize.searchParams.get("state"));
  callback.searchParams.set("code", "offline-authorization-code");
  const callbackResponse = await previousFetch(callback, { headers: { origin: "https://accounts.x.ai" } });
  assert.equal(callbackResponse.status, 200);
  await callbackResponse.text();
  let browserState;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    browserState = JSON.parse((await request("/oauth/api/login/status?provider=xai")).body);
    if (!browserState.pending) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(browserState.status, "authorized", browserState.error);
  assert.equal(browserExchanges, 1);
  assert.equal(records.get(xaiKey).payload.refresh, "offline-browser-refresh");
  assert.equal(records.has(credentialKey("dsh-oauth", "xai-browser")), false, "browser login must not duplicate a secret under an alias key");
  const browserRow = JSON.parse((await request("/oauth/api/providers")).body).providers.find((provider) => provider.id === "xai");
  assert.equal(browserRow.loggedIn, true);
  assert.deepEqual(browserRow.loginMethods, ["browser", "device"]);
  assert.equal(browserRow.defaultLoginMethod, "browser");
  assert.equal(browserRow.cli, "");
  const deviceStarted = JSON.parse((await request("/oauth/api/login", { provider: "xai", method: "device" })).body);
  assert.equal(deviceStarted.code, "OFFLINE-DEVICE");
  assert.equal((await request("/oauth/api/login/cancel", { provider: "xai", attemptId: deviceStarted.attemptId })).status, 200);
  assert.equal(records.get(xaiKey).payload.refresh, "offline-browser-refresh", "cancelling the explicit device fallback leaves saved browser credentials intact");
  removeXaiFlow();

  // A token can be rejected before its advertised expiry. Exercise the public
  // host endpoint, real pi refresh implementation and canonical record commit.
  assert.ok(records.get(xaiKey).payload.expires > Date.now() + 300000);
  let catalogRequests = 0;
  let refreshRequests = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "https://auth.x.ai/oauth2/token") {
      refreshRequests += 1;
      assert.equal(options.body.get("grant_type"), "refresh_token");
      assert.equal(options.body.get("refresh_token"), "offline-browser-refresh");
      return new Response(JSON.stringify({ access_token: "offline-new-xai", refresh_token: "offline-new-refresh", expires_in: 3600 }));
    }
    if (String(url) === "https://api.x.ai/v1/models") return new Response("media permission denied", { status: 403 });
    assert.equal(String(url), "https://cli-chat-proxy.grok.com/v1/models");
    catalogRequests += 1;
    if (catalogRequests === 1) {
      assert.equal(options.headers.authorization, "Bearer offline-browser-access");
      return new Response(JSON.stringify({ error: { code: "invalid_token" } }), { status: 401 });
    }
    assert.equal(options.headers.authorization, "Bearer offline-new-xai");
    return new Response(JSON.stringify({ data: [{ id: "grok-offline", name: "Offline Grok" }] }));
  };
  const recovered = await request("/oauth/api/models", { provider: "xai" });
  assert.equal(recovered.status, 200, recovered.body);
  assert.equal(JSON.parse(recovered.body).models[0].id, "grok-offline");
  assert.equal(catalogRequests, 2);
  assert.equal(refreshRequests, 1);
  assert.equal(records.get(xaiKey).payload.refresh, "offline-new-refresh");
  const permissionRequests = [];
  globalThis.fetch = async (url) => {
    permissionRequests.push(String(url));
    return new Response(JSON.stringify({ code: "permission_denied" }), { status: 403 });
  };
  const denied = await request("/oauth/api/models", { provider: "xai" });
  assert.equal(denied.status, 400);
  assert.match(JSON.parse(denied.body).error, /HTTP 403/);
  assert.equal(refreshRequests, 1, "permission denial must not trigger another refresh");
  assert.deepEqual(permissionRequests, ["https://cli-chat-proxy.grok.com/v1/models"]);
  assert.equal(records.get(xaiKey).payload.refresh, "offline-new-refresh");

  // Exercise chat recovery through Cordis's actual public waterfalls. The LLM
  // stream itself is simulated; no model request or tool execution occurs.
  userSettings.providers.xai = { models: [{ id: "grok-offline", name: "Offline Grok" }] };
  records.set(xaiKey, { kind: "grant", payload: { type: "oauth", access: "offline-chat-old", refresh: "offline-chat-refresh", expires: Date.now() + 3600000 } });
  let chatRefreshRequests = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://auth.x.ai/oauth2/token");
    chatRefreshRequests += 1;
    assert.equal(options.body.get("refresh_token"), "offline-chat-refresh");
    return new Response(JSON.stringify({ access_token: "offline-chat-new", refresh_token: "offline-chat-rotated", expires_in: 3600 }));
  };
  const chatAgent = { session: { id: "offline-host-session" } };
  const chatSignal = new AbortController().signal;
  const chatPosition = { agent: chatAgent, turn: 1, step: 1, signal: chatSignal };
  const chatFailure = { code: "AUTH", message: "xai API error (401): unauthorized" };
  const chatOptions = { provider: "xai", model: "grok-offline", sessionId: chatAgent.session.id, signal: chatSignal, messages: [] };
  const chatAttempt = async () => {
    await ctx.waterfall("agent/request", chatPosition, async () => ({ provider: "xai", model: "grok-offline" }));
    const stream = ctx.waterfall("llm/stream", chatOptions, async function* () { yield { type: "finish", reason: { kind: "error", failure: chatFailure } }; });
    for await (const chunk of stream) assert.equal(chunk.type, "finish");
    return ctx.waterfall("agent/request-error", { ...chatPosition, provider: "xai", failure: chatFailure }, async () => undefined);
  };
  assert.deepEqual(await chatAttempt(), { kind: "retry" });
  assert.equal(chatRefreshRequests, 1);
  assert.equal(records.get(xaiKey).payload.refresh, "offline-chat-rotated");
  assert.equal(await chatAttempt(), undefined, "a second rejection in the same step stays terminal");
  assert.equal(chatRefreshRequests, 1);
  assert.deepEqual(ctx.tools.schemas().map((tool) => tool.name).sort(), ["generate_image", "generate_video"]);
  const assembly = await ctx.systemPrompt.assemble();
  assert.ok(assembly.tools.some((tool) => tool.name === "generate_image"));

  // Subscription imports use real host configuration validation, with every
  // supplier request intercepted. The query key never reaches model settings.
  const connected = await request('/oauth/api/connect', { provider: 'openrouter', access: 'offline-router-key', billingAccess: 'offline-billing-key', label: 'Offline account' });
  assert.equal(connected.status, 200, connected.body);
  const publicRows = await request('/oauth/api/providers');
  assert.equal(publicRows.body.includes('offline-router-key'), false);
  assert.equal(publicRows.body.includes('offline-billing-key'), false);
  const routerRow = JSON.parse(publicRows.body).providers.find(row => row.id === 'openrouter');
  assert.equal(routerRow.credentialConfigured, true);
  assert.equal(routerRow.billingCredentialConfigured, true);
  globalThis.fetch = async (url, options) => {
    const target = String(url); const auth = new Headers(options.headers).get('authorization');
    if (target === 'https://openrouter.ai/api/v1/models/user') {
      assert.equal(auth, 'Bearer offline-router-key');
      return Response.json({ data: [{ id: 'offline/rich', name: 'Offline rich model', context_length: 128000, top_provider: { max_completion_tokens: 8192 }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools'] }] });
    }
    if (target === 'https://openrouter.ai/api/v1/key') {
      assert.equal(auth, 'Bearer offline-router-key');
      return Response.json({ data: { limit: 10, usage: 2, limit_remaining: 8 } });
    }
    assert.equal(target, 'https://openrouter.ai/api/v1/credits');
    assert.equal(auth, 'Bearer offline-billing-key');
    return Response.json({ data: { total_credits: 25, total_usage: 4 } });
  };
  const permanent = await request('/oauth/api/pull', { provider: 'openrouter', models: ['offline/rich'], expiresAt: null });
  assert.equal(permanent.status, 200, permanent.body);
  assert.equal(JSON.parse(permanent.body).expiresAt, null);
  const importedModel = userSettings.providers.openrouter.models[0];
  assert.deepEqual(importedModel.input, ['text', 'image']);
  assert.equal(importedModel.contextWindow, 128000);
  assert.equal(userSettings.providers.openrouter.apiKeyEnv, 'DSH_OAUTH_OPENROUTER_KEY');
  assert.equal(JSON.stringify(userSettings).includes('offline-router-key'), false);
  const savedRich = JSON.parse(await readFile(join(profileDirectory, 'dsh-oauth-pulls.json'), 'utf8')).pulls.openrouter.models[0];
  assert.equal(savedRich.tools, true); assert.deepEqual(savedRich.output, ['text']);
  assert.equal(savedRich.entitlement, 'account');
  const usage = JSON.parse((await request('/oauth/api/usage', { provider: 'openrouter' })).body);
  assert.equal(usage.status, 'fresh'); assert.equal(usage.snapshot.windows[0].remaining, 8);
  assert.equal(usage.snapshot.balances[0].amount, 21);
  assert.equal((await readFile(join(profileDirectory, 'dsh-oauth-usage.json'), 'utf8')).includes('offline-router-key'), false);
  assert.equal(JSON.parse((await request('/oauth/api/providers')).body).providers.find(row => row.id === 'openrouter').pullPermanent, true);
  const replace = await request('/oauth/api/connect', { provider: 'openrouter', access: 'offline-second-account' });
  assert.equal(replace.status, 200, replace.body);
  assert.equal(userSettings.providers.openrouter, undefined, 'changing accounts clears the old owned model route');
  assert.equal(JSON.parse(await readFile(join(profileDirectory, 'dsh-oauth-usage.json'), 'utf8')).entries.openrouter, undefined);
  assert.equal((await request('/oauth/api/logout', { provider: 'openrouter' })).status, 200);
  assert.equal(references.has('DSH_OAUTH_OPENROUTER_KEY'), false);
  assert.equal(records.has(credentialKey('dsh-oauth-connections', 'openrouter')), false);
  for (const providerId of ['minimax', 'zai', 'aliyun-token-plan']) {
    globalThis.fetch = async () => { throw new Error('Installed catalog must not issue a model or inference request.'); };
    assert.equal((await request('/oauth/api/connect', { provider: providerId, access: `offline-${providerId}`, region: 'cn' })).status, 200);
    const catalog = await request('/oauth/api/models', { provider: providerId });
    assert.equal(catalog.status, 200, catalog.body);
    const model = JSON.parse(catalog.body).models[0];
    assert.equal(model.source, 'installed-catalog'); assert.equal(model.entitlement, 'unknown');
    const save = await request('/oauth/api/pull', { provider: providerId, models: [model.id], expiresAt: null });
    assert.equal(save.status, 200, save.body);
    assert.ok(userSettings.providers[providerId].apiKeyEnv);
    if (providerId === 'minimax') assert.equal(userSettings.providers[providerId].api, 'anthropic-messages');
    else assert.equal(userSettings.providers[providerId].api, 'openai-completions');
    assert.equal((await request('/oauth/api/logout', { provider: providerId })).status, 200);
  }

  // Execute the published browser bundle's factory with its actual modules, then exercise its real SlotRegistry.
  const browserModules = new Map([
    ["@deepseek-ai/cordis", await load("@deepseek-ai/cordis")], ["@deepseek-ai/dsh-client-ui-slots", slotsModule],
    ...await Promise.all(["react", "react-dom", "react-dom/client", "react/jsx-runtime"].map(async (name) => [name, requireRuntime(name)])),
  ]);
  async function browserPlugin(path) {
    let descriptor;
    new Function("window", await readFile(path, "utf8"))({ __ModuleLoader__: { load: (value) => { descriptor = value; } } });
    assert.ok(descriptor?.factory);
    if (path === join(pluginRoot, 'client.js')) assert.equal(descriptor.id, JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')).name, 'client module ID must match the published package');
    return descriptor.factory((name) => { assert.ok(browserModules.has(name), `missing browser module ${name}`); return browserModules.get(name); });
  }
  const renderer = await browserPlugin(requireRuntime.resolve("@deepseek-ai/dsh-client-ui-renderer/client"));
  await ctx.plugin(renderer.SlotRegistry);
  ctx.slots.register({ name: "root", children: { "settings.section": { kind: "list", scope: "root" } } }, () => null);
  const client = await browserPlugin(join(pluginRoot, "client.js"));
  const clientFiber = ctx.plugin(client);
  await clientFiber;
  const entry = ctx.slots.entries("settings.section").find((value) => value.options.id === "oauth");
  assert.ok(entry, "OAuth is registered into the actual settings slot registry");
  const iframe = entry.component({});
  assert.equal(iframe.type, "iframe");
  assert.equal(iframe.props.src, "/oauth/");
  await clientFiber.dispose();
  assert.equal(ctx.slots.entries("settings.section").length, 0, "unloading removes the client slot");
  await fiber.dispose();
  assert.equal(routes.length, 0, "unloading removes the web route");
  assert.equal(ctx.tools.schemas().length, 0, "unloading removes media tools");
  assert.equal(ctx.authorization?.describe(key), undefined, "unloading removes the Qwen authorization flow");
  const versions = {};
  for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-authorization", "@deepseek-ai/dsh-credentials", "@deepseek-ai/dsh-settings", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-system-prompt", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-llm-pi-ai", "@earendil-works/pi-ai"]) {
    versions[name] = JSON.parse(await readFile(join(modules, name, "package.json"), "utf8")).version;
  }
  const sourceSha256 = {};
  const sourceFiles = ["package.json", "client.js", ...(await readdir(join(pluginRoot, "src"), { recursive: true })).filter((file) => file.endsWith(".js") && !file.endsWith(".test.js")).sort().map((file) => `src/${file}`)];
  for (const file of sourceFiles) sourceSha256[file] = createHash("sha256").update(await readFile(join(pluginRoot, file))).digest("hex");
  console.log(JSON.stringify({ ok: true, versions, sourceSha256, checks: ["host route", "provider listing", "DeepSeek callback metadata and attempt identity", "DeepSeek stale cancellation refusal", "DeepSeek commit before cancellation", "Qwen device notice and authorization commit", "Qwen standard verification URI fallback", "Qwen disconnect wins delayed record and access-reference writes", "subsequent legitimate Qwen login remains configured", "pull settings parsed by actual adapter schema", "pull persistence", "logout route restoration", "xAI defaults to loopback PKCE and preserves existing six scopes", "xAI production OIDC validation precedes the single canonical grant commit", "pending xAI login cannot silently switch methods", "explicit device fallback and cancellation preserve browser grant", "model catalog rejects future-valid token, refreshes once and retries with persisted grant", "permission denial preserves authorization without forced refresh", "public chat waterfalls persist a forced refresh before retrying", "second chat rejection in the same step does not refresh or retry again", "tool schemas", "settings slot", "unload", "subscription key and billing credential isolation", "account-filtered model capabilities and permanent settings", "quota cache without secrets", "account replacement clears old owned route and snapshot", "MiniMax/ZAI/Ali regional protocol profiles validated by real schema"], network: "mock xAI/provider fetch only, with actual loopback callback HTTP", persistentProfile: "temporary directory only" }, null, 2));
} finally {
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  await ctx?.fiber.dispose();
  await rm(temporary, { recursive: true, force: true });
}
