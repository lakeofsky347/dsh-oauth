/**
 * Host half: serve the OAuth panel, and drive the harness authorization
 * seam so "登录" opens the provider's own page.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import AuthorizationService from "@deepseek-ai/dsh-authorization";
import { credentialKey, credentialKeyId, credentialKeyScope } from "@deepseek-ai/dsh-credentials";
import { accountClientFrom, loginCallbackOrigin, loginSource, signInFailed } from "./account.js";
import { registerMediaTools } from "./media.js";
import { fetchAccountModels } from "./models.js";
import { createPullStore } from "./pulls.js";
import { loginQwen, qwenEndpoint } from "./qwen.js";
import { createAuthorizationSessions } from "./authorization.js";
import { createGrantResolver, QWEN_KEY_NAME } from "./grants.js";
import { restoreRoute, writeRoute } from "./routes.js";
import { withGrantRecovery } from "./request-errors.js";
import { registerChatRecovery } from "./chat-recovery.js";
import { createXaiBrowserAuthorization } from "./xai-login.js";
import { createConnectionRuntime } from "./connection-runtime.js";
import { connectionRef, connectionMetadata, validSecret } from "./connections.js";
import { createUsageService, usageIds } from "./usage/index.js";
import { providerDefinitions, getProviderDefinition } from "./catalog.js";
import { discoverLocalSources, readLocalSource } from "./local-imports.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
const PI_AI = "llm-pi-ai";
const OAUTH_SCOPE = "dsh-oauth";
const QWEN_ID = "qwen";
const DEEPSEEK_ACCOUNT = "deepseek-account";
const DEEPSEEK_KEY = credentialKey("deepseek-account-platform", "default");

const FILES = {
  "/oauth": "index.html",
  "/oauth/": "index.html",
  "/oauth/index.html": "index.html",
  "/oauth/app.js": "app.js",
  "/oauth/auth.html": "auth.html",
  "/oauth/providers.js": "providers.js",
  "/oauth/styles.css": "styles.css",
  "/oauth/theme.js": "theme.js",
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export const name = "dsh-oauth";
export const inject = ["credentials", "settings"];

const runtimes = new WeakMap();

export async function apply(ctx) {
  const sessions = new Map();
  const authorizationSessions = createAuthorizationSessions({ sessions });
  const connectionRuntime = createConnectionRuntime(ctx.credentials, createGrantResolver(ctx.credentials));
  const resolveGrant = connectionRuntime.resolve;
  const pulls = createPullStore(ctx.profileContext?.dir);
  const usage = createUsageService({ directory: ctx.profileContext?.dir, contextFor: connectionRuntime.contextFor });
  runtimes.set(ctx, { sessions, authorizationSessions, resolveGrant, pulls, connectionRuntime, usage, mutations: new Map() });
  ctx.on('llm/stream', (options, next) => (async function* () {
    if (typeof options.provider === 'string') {
      await mutateProvider(ctx, options.provider, async () => {
        const connection = await connectionRuntime.connections.read(options.provider);
        const pull = await currentPull(ctx, options.provider);
        if (connection?.mode === 'local' || connection?.mode === 'key') {
          if (!pull) throw new Error('Import the selected connection’s models before using this provider.');
          await resolveGrant(options.provider);
        }
        const model = pull?.models?.find(row => row.id === options.model);
        if (model?.tools === false && Array.isArray(options.tools) && options.tools.length) throw new Error('This imported model explicitly does not support tool calls. Choose a model with tool support.');
      });
    }
    yield* next();
  })());
  ctx.on("dispose", () => runtimes.get(ctx)?.xaiBrowser?.dispose());
  registerChatRecovery(ctx, resolveGrant);
  ctx.on("dispose", () => authorizationSessions.dispose());
  if (ctx.get("authorization") === undefined) {
    try {
      await ctx.plugin(AuthorizationService);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("has been registered")) throw error;
    }
  }
  const serve = (req, res) => handle(ctx, req, res).catch((error) => {
    if (!res.headersSent) json(res, error instanceof SyntaxError ? 400 : 500, {
      error: error instanceof Error ? error.message : String(error),
    });
    else res.end();
  });
  ctx.inject(["authorization"], (scoped) => {
    scoped.effect(() => registerCodingPlanFlows(ctx, scoped.authorization ?? scoped.get?.("authorization")));
  });
  ctx.inject(["tools", "systemPrompt"], (scoped) => {
    registerMediaTools(scoped, resolveGrant, pulls);
  });
  ctx.inject(["webServer"], (web) => {
    web.effect(() => web.webServer.register({
      kind: "prefix",
      path: "/oauth",
      handler: serve,
    }), "dsh-oauth: panel");
  });
  let maintaining = false;
  const maintain = async () => {
    if (maintaining) return;
    maintaining = true;
    try {
      for (const pull of await pulls.list({ includeExpired: true })) {
        try {
          if (pull.expiresAt !== null && pull.expiresAt <= Date.now()) await currentPull(ctx, pull.id);
          else if (pull.id === QWEN_ID || (await connectionRuntime.connections.read(pull.id))?.mode === 'local') await resolveGrant(pull.id);
        } catch (error) {
          ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
    } finally { maintaining = false; }
  };
  const timer = setInterval(() => void maintain(), 60000);
  timer.unref?.();
  ctx.on("dispose", () => clearInterval(timer));
  void maintain();
}

async function handle(ctx, req, res) {
  const { sessions, authorizationSessions } = runtimes.get(ctx);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/oauth/api/login/status" && req.method === "GET") {
    const id = providerId(url.searchParams.get("provider"));
    if (!id) return json(res, 400, { error: "需要 provider id" });
    if (id === DEEPSEEK_ACCOUNT) await updateDeepSeekSession(ctx);
    return json(res, 200, authorizationSessions.get(id) ?? { status: "idle", pending: false });
  }
  if ((url.pathname === "/oauth/api/login/answer" || url.pathname === "/oauth/api/login/cancel") && req.method === "POST") {
    const body = await readJson(req);
    const id = providerId(body.provider);
    if (!id) return json(res, 400, { error: "需要 provider id" });
    try {
      if (url.pathname.endsWith("/answer")) authorizationSessions.answer(id, body);
      else {
        if (id === DEEPSEEK_ACCOUNT) {
          const session = sessions.get(id);
          if (!session || typeof body.attemptId !== "string" || session.attemptId !== body.attemptId) {
            throw new Error("登录尝试已更新，请刷新后重试");
          }
          if (session.status === "pending") {
            const account = deepseekAccount(ctx);
            if (session.upstreamAttemptId) await account.cancelSignIn(session.upstreamAttemptId);
            await updateDeepSeekSession(ctx);
            if (session.status === "pending") session.status = "cancelled";
          }
        } else authorizationSessions.cancel(id, body);
      }
      return json(res, 200, authorizationSessions.get(id));
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (url.pathname === "/oauth/api/providers" && req.method === "GET") {
    return json(res, 200, { version: VERSION, providers: await listProviders(ctx) });
  }
  if (url.pathname === '/oauth/api/import/sources' && req.method === 'GET') {
    const sources = await discoverLocalSources();
    for (const source of sources) {
      source.providers = source.providers.map(row => {
        const definition = getProviderDefinition(row.provider);
        const supported = !!definition && (row.authType === 'oauth' || definition.keyConnect);
        return supported ? row : { ...row, available: false, reasonCode: 'unsupported-provider' };
      });
      source.available = source.providers.some(row => row.available);
    }
    return json(res, 200, { sources });
  }
  if (['/oauth/api/connect', '/oauth/api/connection', '/oauth/api/usage', '/oauth/api/import'].includes(url.pathname) && req.method === 'POST') {
    const body = await readJson(req);
    const id = providerId(body.provider);
    if (!id) return json(res, 400, { error: '需要 provider id' });
    const runtime = runtimes.get(ctx);
    try {
      if (url.pathname.endsWith('/usage')) return json(res, 200, await runtime.usage.get(id, { force: body.force === true }));
      await mutateProvider(ctx, id, async () => {
        if (runtime.sessions.get(id)?.status === 'pending') throw new Error('Cancel the pending login before replacing this connection.');
        const definition = getProviderDefinition(id, body);
        if (url.pathname.endsWith('/connect')) {
          if (!definition?.keyConnect) throw new Error('This provider does not support this key connection.');
          validSecret(body.access); connectionMetadata(body);
          if (body.billingAccess) validSecret(body.billingAccess);
          if (id === 'zai' && !!body.organizationId !== !!body.projectId) throw new Error('Z.AI organization and project IDs must be configured together.');
          await dropRoute(ctx, id);
          await runtime.connectionRuntime.connections.connect(id, body);
        } else if (url.pathname.endsWith('/import')) {
          const imported = await readLocalSource(body.source, id);
          if (!definition || imported.grant.type === 'api_key' && !definition.keyConnect) throw new Error('This local credential has no supported model route.');
          await dropRoute(ctx, id);
          await runtime.connectionRuntime.connections.saveLocal(id, body.source, imported.label);
          await runtime.resolveGrant(id);
        } else {
          if (!definition) throw new Error('Unknown provider.');
          const current = await runtime.connectionRuntime.connections.read(id);
          const metadata = { ...current?.metadata, ...connectionMetadata(body) };
          if (id === 'new-api' && !getProviderDefinition(id, metadata)?.keyConnect) throw new Error('Configure a valid HTTPS gateway API root.');
          if (id === 'zai' && !!metadata.organizationId !== !!metadata.projectId) throw new Error('Z.AI organization and project IDs must be configured together.');
          if (body.billingAccess) validSecret(body.billingAccess);
          // Endpoint/scope changes require re-import, so an old route cannot use a new region's key.
          if (['region', 'baseURL', 'organizationId', 'workspaceId', 'projectId'].some(key => body[key] !== undefined)) await dropRoute(ctx, id);
          await runtime.connectionRuntime.connections.configure(id, body);
        }
        await runtime.usage.invalidate(id);
      });
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Connection failed.' }); }
  }
  if (url.pathname === "/oauth/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const id = typeof body.provider === "string" ? body.provider : "";
    if (!/^[a-z][a-z0-9-]*$/.test(id)) return json(res, 400, { error: "需要 provider id" });
    try {
      const started = await startLogin(ctx, id, req, body.method);
      return json(res, 200, started);
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (url.pathname === "/oauth/api/models" && req.method === "POST") {
    const body = await readJson(req);
    const id = providerId(body.provider);
    if (id === undefined) return json(res, 400, { error: "需要 provider id" });
    try {
      const models = await accountModels(ctx, id);
      return json(res, 200, { models });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (url.pathname === "/oauth/api/pull" && req.method === "POST") {
    const body = await readJson(req);
    const id = providerId(body.provider);
    if (id === undefined) return json(res, 400, { error: "需要 provider id" });
    try {
      const saved = await mutateProvider(ctx, id, () => savePull(ctx, id, body));
      return json(res, 200, saved);
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (url.pathname === "/oauth/api/logout" && req.method === "POST") {
    const body = await readJson(req);
    const id = providerId(body.provider);
    if (id === undefined) return json(res, 400, { error: "需要 provider id" });
    authorizationSessions.clear(id);
    if (id === "xai") {
      runtimes.get(ctx).xaiBrowser?.cancel(credentialKey(PI_AI, "xai"));
      ctx.get("authorization")?.cancel(credentialKey(PI_AI, "xai"));
    }
    if (id === DEEPSEEK_ACCOUNT) {
      const account = deepseekAccount(ctx);
      if (account !== undefined && typeof account.signOut === "function") {
        await account.signOut(accountClientFrom(req));
      } else await ctx.credentials.deleteRecord(DEEPSEEK_KEY);
    } else {
      const disconnect = async () => {
        await runtimes.get(ctx).usage.invalidate(id);
        await runtimes.get(ctx).connectionRuntime.connections.disconnect(id);
        await ctx.credentials.deleteRecord(credentialKey(id === QWEN_ID ? OAUTH_SCOPE : PI_AI, id));
        if (id === QWEN_ID && typeof ctx.credentials.unset === "function") await ctx.credentials.unset(QWEN_KEY_NAME);
        await dropRoute(ctx, id);
      };
      if (id === QWEN_ID) await mutateQwenLogin(ctx, disconnect);
      else await mutateProvider(ctx, id, disconnect);
    }
    return json(res, 200, { ok: true });
  }
  const file = FILES[url.pathname];
  if (file === undefined || req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const body = await readFile(join(ROOT, file));
  const type = TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function listProviders(ctx) {
  const { sessions } = runtimes.get(ctx);
  const authorization = ctx.get("authorization");
  const flows = (authorization?.list() ?? []).filter((entry) =>
    credentialKeyScope(entry.key) === PI_AI && entry.methods.some((method) => method.id === "oauth"));
  const rows = [];
  for (const flow of flows) {
    const id = credentialKeyId(flow.key);
    const info = await ctx.credentials.describeRecord(flow.key);
    const loggedIn = info.configured && info.kind === "grant";
    let tokenPreview = "";
    let expiresAt = null;
    if (loggedIn) {
      const record = await ctx.credentials.readRecord(flow.key);
      const payload = record?.kind === "grant" ? record.payload : undefined;
      const access = payload && typeof payload === "object" ? payload.access : undefined;
      if (typeof access === "string" && access.length > 8) {
        tokenPreview = `${access.slice(0, 4)}…${access.slice(-4)}`;
      }
      const expires = payload && typeof payload === "object" ? payload.expires : undefined;
      if (typeof expires === "number") expiresAt = expires;
    }
    const pull = await currentPull(ctx, id);
    const session = sessions.get(id);
    rows.push({
      id,
      name: flow.label,
      flow: "pkce",
      ...(id === "xai" ? { loginMethods: ["browser", "device"], defaultLoginMethod: "browser" } : {}),
      group: "订阅 OAuth",
      pullable: ["openai-codex", "anthropic", "github-copilot", "kimi-coding", "openrouter", "xai"].includes(id),
      cli: id === "xai" ? "" : `dsh oauth login ${id}`,
      docs: "#",
      loggedIn,
      tokenPreview,
      expiresAt,
      sourceLabel: loggedIn ? "本机登录" : "",
      pending: session?.status === "pending",
      error: session?.error ?? "",
      pulledModels: [...(pull?.models ?? []), ...(pull?.media ?? [])],
      pullExpiresAt: pull?.expiresAt ?? null,
    });
  }
  rows.push(await qwenRow(ctx));
  const deepseek = await deepseekRow(ctx);
  if (deepseek !== undefined) rows.push(deepseek);
  for (const definition of providerDefinitions) {
    if (!rows.some(row => row.id === definition.id)) rows.push({ id: definition.id, name: definition.name, group: definition.group, flow: 'key', loggedIn: false, pending: false, pulledModels: [], cli: '', docs: definition.docs ?? '#' });
  }
  for (const row of rows) {
    const runtime = runtimes.get(ctx);
    const connection = await runtime.connectionRuntime.connections.read(row.id);
    const definition = getProviderDefinition(row.id, connection?.metadata);
    const pull = await currentPull(ctx, row.id);
    const native = row.flow !== 'key';
    row.keyConnect = definition?.keyConnect === true || row.id === 'new-api' || row.id === 'aliyun-token-plan';
    row.authMethods = [...(native ? ['oauth'] : []), ...(row.keyConnect ? ['key'] : []), ...(definition ? ['local'] : [])];
    row.usageSupported = usageIds.has(row.id);
    row.credentialConfigured = !!connection?.access || row.loggedIn || connection?.mode === 'local';
    row.billingCredentialConfigured = !!connection?.billingAccess;
    row.loggedIn = row.credentialConfigured;
    row.connection = connection?.metadata ?? {};
    row.sourceLabel = connection?.mode === 'key' ? 'API Key' : connection?.mode === 'local' ? `${connection.sourceLabel} · external-managed` : row.sourceLabel;
    row.pullable = row.pullable || !!definition?.modelsURL || !!definition?.catalogProvider;
    row.pulledModels = [...(pull?.models ?? []), ...(pull?.media ?? [])];
    row.pullExpiresAt = pull?.expiresAt ?? null;
    row.pullPermanent = !!pull && pull.expiresAt === null;
    row.modelSource = definition?.modelSource;
    row.supportReason = definition?.reason;
    delete row.tokenPreview;
  }
  return rows;
}

function mutateProvider(ctx, id, operation) {
  const mutations = runtimes.get(ctx).mutations;
  const next = (mutations.get(id) ?? Promise.resolve()).then(operation);
  mutations.set(id, next.catch(() => {}));
  return next;
}

function registerCodingPlanFlows(ctx, authorization) {
  if (authorization === undefined || typeof authorization.registerFlow !== "function") return;
  const key = credentialKey(OAUTH_SCOPE, QWEN_ID);
  try {
    return authorization.registerFlow({
      key,
      label: "通义千问",
      methods: [{ id: "oauth", label: "浏览器登录" }],
      async run(session) {
        const grant = await loginQwen(session);
        await mutateQwenLogin(ctx, async () => {
          session.signal.throwIfAborted();
          await ctx.credentials.modifyRecord(key, async () => {
            // A cancellation can win while this write waits for the record lock.
            session.signal.throwIfAborted();
            return {
              kind: "grant",
              payload: {
                access: grant.access,
                ...(grant.refresh === undefined ? {} : { refresh: grant.refresh }),
                expires: grant.expires,
                resourceUrl: grant.resourceUrl,
              },
            };
          });
          session.signal.throwIfAborted();
          if (typeof ctx.credentials.set === "function") await ctx.credentials.set(QWEN_KEY_NAME, grant.access);
        });
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("already registered")) throw error;
  }
}

/** Let an explicit disconnect clear both writes after any in-flight Qwen login commit. */
function mutateQwenLogin(ctx, mutate) {
  const runtime = runtimes.get(ctx);
  const next = (runtime.qwenLoginWrite ?? Promise.resolve()).then(mutate);
  runtime.qwenLoginWrite = next.catch(() => {});
  return next;
}

async function qwenRow(ctx) {
  const { sessions } = runtimes.get(ctx);
  const key = credentialKey(OAUTH_SCOPE, QWEN_ID);
  const info = await ctx.credentials.describeRecord(key);
  const loggedIn = info.configured && info.kind === "grant";
  const pull = await currentPull(ctx, QWEN_ID);
  const session = sessions.get(QWEN_ID);
  let tokenPreview = "";
  let expiresAt = null;
  if (loggedIn) {
    const record = await ctx.credentials.readRecord(key);
    const payload = record?.kind === "grant" ? record.payload : undefined;
    tokenPreview = tokenPreviewOf(payload);
    if (payload && typeof payload.expires === "number") expiresAt = payload.expires;
  }
  return {
    id: QWEN_ID,
    name: "通义千问",
    flow: "pkce",
    group: "Coding Plan",
    pullable: true,
    cli: "",
    docs: "https://chat.qwen.ai",
    loggedIn,
    tokenPreview,
    expiresAt,
    sourceLabel: loggedIn ? "通义千问账号" : "",
    pending: session?.status === "pending",
    error: session?.error ?? "",
    pulledModels: [...(pull?.models ?? []), ...(pull?.media ?? [])],
    pullExpiresAt: pull?.expiresAt ?? null,
  };
}

async function deepseekRow(ctx) {
  const { sessions } = runtimes.get(ctx);
  await updateDeepSeekSession(ctx);
  const account = deepseekAccount(ctx);
  let info;
  try {
    info = await ctx.credentials.describeRecord(DEEPSEEK_KEY);
  } catch {
    if (account === undefined) return undefined;
  }
  if (account === undefined && info?.configured !== true) return undefined;
  const loggedIn = info?.configured === true && info.kind === "grant";
  let tokenPreview = "";
  if (loggedIn) {
    const record = await ctx.credentials.readRecord(DEEPSEEK_KEY);
    const payload = record?.kind === "grant" ? record.payload : undefined;
    tokenPreview = tokenPreviewOf(payload);
  }
  const session = sessions.get(DEEPSEEK_ACCOUNT);
  return {
    id: DEEPSEEK_ACCOUNT,
    name: "DeepSeek 官方账号",
    flow: "browser",
    group: "官方账号",
    pullable: false,
    cli: "",
    docs: "https://platform.deepseek.com",
    loggedIn,
    tokenPreview,
    expiresAt: null,
    sourceLabel: loggedIn ? "官方账号" : "",
    pending: session?.status === "pending",
    error: session?.error ?? "",
    pulledModels: [],
    pullExpiresAt: null,
  };
}

function tokenPreviewOf(payload) {
  const token = payload && typeof payload === "object"
    ? (typeof payload.access === "string" ? payload.access : typeof payload.token === "string" ? payload.token : "")
    : "";
  return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "";
}

function deepseekAccount(ctx) {
  try {
    const account = ctx.get("deepseekAccount");
    return account && typeof account === "object" ? account : undefined;
  } catch {
    return undefined;
  }
}

async function startLogin(ctx, id, req, method) {
  const runtime = runtimes.get(ctx);
  if (runtime.sessions.get(id)?.status !== 'pending' && id !== DEEPSEEK_ACCOUNT) {
    await mutateProvider(ctx, id, async () => {
      await runtime.usage.invalidate(id);
      await runtime.connectionRuntime.connections.disconnect(id);
      await dropRoute(ctx, id);
    });
  }
  if (id === "xai") {
    if (method !== undefined && method !== "browser" && method !== "device") throw new Error("xAI 登录方式无效");
    const authorization = ctx.get("authorization");
    if (!authorization) throw new Error("authorization 服务还没有挂上");
    const runtime = runtimes.get(ctx);
    const selected = method ?? "browser";
    if (runtime.sessions.get(id)?.status === "pending") {
      if (runtime.xaiLoginMethod !== selected) throw new Error("请先取消当前 xAI 登录，再切换登录方式");
      return runtime.authorizationSessions.get(id);
    }
    runtime.xaiLoginMethod = selected;
    if (!runtime.xaiBrowser || runtime.xaiBrowserHost !== authorization) {
      runtime.xaiBrowser?.dispose();
      runtime.xaiBrowser = createXaiBrowserAuthorization(ctx, authorization);
      runtime.xaiBrowserHost = authorization;
    }
    if (method === "device") {
      if (runtime.xaiBrowser.describe(credentialKey(PI_AI, "xai"))?.inFlight) {
        throw new Error("xAI 正在登录，请先完成或取消当前尝试");
      }
      return startScopedLogin(ctx, id, PI_AI);
    }
    return runtime.authorizationSessions.begin(runtime.xaiBrowser, id, credentialKey(PI_AI, "xai"));
  }
  if (id === DEEPSEEK_ACCOUNT) return startDeepSeekLogin(ctx, req);
  if (id === QWEN_ID) return startScopedLogin(ctx, id, OAUTH_SCOPE);
  return startScopedLogin(ctx, id, PI_AI);
}

async function startScopedLogin(ctx, id, scope) {
  const authorization = ctx.get("authorization");
  if (authorization === undefined) throw new Error("authorization 服务还没有挂上");
  const key = credentialKey(scope, id);
  const flow = authorization.describe(key);
  if (flow === undefined || !flow.methods.some((method) => method.id === "oauth")) {
    throw new Error(`没有 ${id} 的 OAuth 登录`);
  }
  return runtimes.get(ctx).authorizationSessions.begin(authorization, id, key);
}

async function startDeepSeekLogin(ctx, req) {
  const { sessions } = runtimes.get(ctx);
  const account = deepseekAccount(ctx);
  if (account === undefined || typeof account.startSignIn !== "function") {
    throw new Error("当前桌面版没有挂上 DeepSeek 官方账号登录");
  }
  const origin = loginCallbackOrigin(req.headers?.host);
  const source = loginSource(origin);
  const attemptId = randomUUID();
  sessions.set(DEEPSEEK_ACCOUNT, { status: "pending", attemptId });
  let state;
  try { state = await account.startSignIn(accountClientFrom(req), origin, source); }
  catch (error) {
    sessions.set(DEEPSEEK_ACCOUNT, { status: "error", attemptId, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const session = sessions.get(DEEPSEEK_ACCOUNT);
  session.upstreamAttemptId = state?.attempt?.id;
  let url = state?.attempt?.authorizeUrl;
  for (let attempt = 0; attempt < 40 && (typeof url !== "string" || url.length === 0); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const next = await account.getState();
    session.upstreamAttemptId = next?.attempt?.id ?? session.upstreamAttemptId;
    const phase = next?.attempt?.phase;
    if (signInFailed(phase)) {
      const message = "DeepSeek 官方账号登录没有完成";
      sessions.set(DEEPSEEK_ACCOUNT, { status: "error", error: message, attemptId });
      throw new Error(message);
    }
    url = next?.attempt?.authorizeUrl;
    if (next?.status === "credential-stored" && (phase === "succeeded" || phase === undefined)) break;
  }
  if (typeof url === "string" && url.length > 0) session.url = url;
  await updateDeepSeekSession(ctx);
  return runtimes.get(ctx).authorizationSessions.get(DEEPSEEK_ACCOUNT);
}

async function updateDeepSeekSession(ctx) {
  const session = runtimes.get(ctx).sessions.get(DEEPSEEK_ACCOUNT);
  if (session?.status !== "pending") return;
  const state = await deepseekAccount(ctx)?.getState?.();
  if (state?.attempt?.id) session.upstreamAttemptId = state.attempt.id;
  if (signInFailed(state?.attempt?.phase)) {
    session.status = state.attempt.phase === "cancelled" ? "cancelled" : "error";
    if (session.status === "error") session.error = "DeepSeek 官方账号登录没有完成";
  } else if (state?.status === "credential-stored" && (!state.attempt || state.attempt.phase === "succeeded")) {
    session.status = "authorized";
  }
}

function providerId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value) ? value : undefined;
}

async function grantPayload(ctx, id) {
  return runtimes.get(ctx).resolveGrant(id);
}

async function accountModels(ctx, id) {
  const connection = await runtimes.get(ctx).connectionRuntime.connections.read(id);
  return withGrantRecovery(id, runtimes.get(ctx).resolveGrant,
    (grant) => fetchAccountModels(id, { ...grant, ...connection?.metadata }));
}

async function currentPull(ctx, id) {
  const pull = await runtimes.get(ctx).pulls.read(id);
  if (pull === undefined) return undefined;
  if (pull.expiresAt === null || pull.expiresAt > Date.now()) return pull;
  await dropRoute(ctx, id);
  return undefined;
}

async function savePull(ctx, id, body) {
  const available = await accountModels(ctx, id);
  const known = new Map(available.map((model) => [model.id, model]));
  const chosen = Array.isArray(body.models) ? body.models.filter((modelId) => typeof modelId === "string" && known.has(modelId)) : [];
  if (chosen.length === 0) throw new Error("至少选择一个从该 OAuth 账号拉到的模型");
  const expiresAt = body.expiresAt === null || body.expiresAt === undefined ? null : Number(body.expiresAt);
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error("过期时间要晚于现在");
  if (expiresAt !== null && expiresAt > Date.now() + 366 * 24 * 60 * 60 * 1000) throw new Error("过期时间不能超过一年");
  const chat = chosen.map((modelId) => known.get(modelId)).filter((model) => model.role === "chat");
  if (chat.length === 0) throw new Error("至少选择一个对话模型。生图和生视频模型不会替换当前对话。");
  const payload = await grantPayload(ctx, id);
  if (id === QWEN_ID && typeof payload.access === "string" && typeof ctx.credentials.set === "function") {
    await ctx.credentials.set(QWEN_KEY_NAME, payload.access);
  }
  const models = chat.map(modelProfile);
  const custom = await runtimes.get(ctx).connectionRuntime.customRoute(id);
  const connection = await runtimes.get(ctx).connectionRuntime.connections.read(id);
  const definition = getProviderDefinition(id, connection?.metadata);
  if (custom && !definition?.baseURL) throw new Error('This subscription has no verified inference endpoint for the selected region.');
  const codingPlan = custom ? {
    displayName: definition.name, api: definition.api ?? 'openai-completions', baseURL: definition.baseURL,
    apiKeyEnv: connectionRef(id), defaultInput: ['text'], models,
    ...(definition.routeHeaders ? { headers: definition.routeHeaders } : {}),
  } : id === QWEN_ID ? {
    displayName: "通义千问",
    api: "openai-completions",
    baseURL: qwenEndpoint(payload.resourceUrl),
    apiKeyEnv: QWEN_KEY_NAME,
    defaultInput: ["text"],
    models,
  } : undefined;
  const previous = await runtimes.get(ctx).pulls.read(id);
  const route = await writeRoute(ctx.settings, id, models, codingPlan, previous?.route);
  const pull = {
    models: chat,
    media: available.filter((model) => model.role === "image" || model.role === "video"),
    expiresAt,
    importedAt: new Date().toISOString(),
    source: custom ? 'api-key' : connection?.mode === 'local' ? 'external-managed' : 'oauth',
    route: { edits: route.edits },
  };
  try { await runtimes.get(ctx).pulls.write(id, pull); }
  catch (error) { await restoreRoute(ctx.settings, route.rollback); throw error; }
  return pull;
}

function modelProfile(model) {
  const entry = { id: model.id, name: model.name };
  if (Number.isInteger(model.contextWindow) && model.contextWindow > 0) entry.contextWindow = model.contextWindow;
  if (Number.isInteger(model.maxTokens) && model.maxTokens > 0) entry.maxTokens = model.maxTokens;
  if (Array.isArray(model.input) && model.input.length > 0) entry.input = model.input;
  if (model.reasoningEfforts === false || model.reasoningEfforts && typeof model.reasoningEfforts === "object") entry.reasoningEfforts = model.reasoningEfforts;
  if (model.compat && typeof model.compat === 'object') entry.compat = model.compat;
  return entry;
}

async function dropRoute(ctx, id) {
  const pull = await runtimes.get(ctx).pulls.read(id);
  await restoreRoute(ctx.settings, pull?.route);
  await runtimes.get(ctx).pulls.delete(id);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new SyntaxError('Request is too large.'); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : {};
}
