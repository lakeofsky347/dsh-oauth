/**
 * Host half: serve the OAuth panel, and drive the harness authorization
 * seam so "登录" opens the provider's own page.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import AuthorizationService from "@deepseek-ai/dsh-authorization";
import { credentialKey, credentialKeyId, credentialKeyScope } from "@deepseek-ai/dsh-credentials";
import { registerMediaTools } from "./media.js";
import { fetchAccountModels } from "./models.js";
import { deletePull, readPull, writePull } from "./pulls.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_AI = "llm-pi-ai";
const SETTINGS = "llm-pi-ai";

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

/** @type {Map<string, { url?: string, code?: string, status?: string, error?: string }>} */
const sessions = new Map();

export async function apply(ctx) {
  if (ctx.get("authorization") === undefined) {
    await ctx.plugin(AuthorizationService);
  }
  const serve = (req, res) => handle(ctx, req, res);
  ctx.inject(["tools", "systemPrompt"], (scoped) => {
    registerMediaTools(scoped);
  });
  ctx.inject(["webServer"], (web) => {
    web.effect(() => web.webServer.register({
      kind: "prefix",
      path: "/oauth",
      handler: serve,
    }), "dsh-oauth: panel");
  });
}

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/oauth/api/providers" && req.method === "GET") {
    return json(res, 200, { providers: await listProviders(ctx) });
  }
  if (url.pathname === "/oauth/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const id = typeof body.provider === "string" ? body.provider : "";
    if (!/^[a-z][a-z0-9-]*$/.test(id)) return json(res, 400, { error: "需要 provider id" });
    try {
      const started = await startLogin(ctx, id);
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
      const models = await fetchAccountModels(id, await grantPayload(ctx, id));
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
      const saved = await savePull(ctx, id, body);
      return json(res, 200, saved);
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (url.pathname === "/oauth/api/logout" && req.method === "POST") {
    const body = await readJson(req);
    const id = providerId(body.provider);
    if (id === undefined) return json(res, 400, { error: "需要 provider id" });
    await ctx.credentials.deleteRecord(credentialKey(PI_AI, id));
    await deletePull(id);
    await dropRoute(ctx, id);
    sessions.delete(id);
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
      cli: `dsh oauth login ${id}`,
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
  return rows;
}

async function startLogin(ctx, id) {
  const authorization = ctx.get("authorization");
  if (authorization === undefined) throw new Error("authorization 服务还没有挂上");
  const key = credentialKey(PI_AI, id);
  const flow = authorization.describe(key);
  if (flow === undefined || !flow.methods.some((method) => method.id === "oauth")) {
    throw new Error(`没有 ${id} 的 OAuth 登录`);
  }
  if (flow.inFlight) {
    const existing = sessions.get(id);
    return { url: existing?.url ?? "", code: existing?.code ?? "", pending: true };
  }
  sessions.set(id, { status: "pending" });
  let resolveUrl;
  const urlReady = new Promise((resolve) => {
    resolveUrl = resolve;
  });
  const attempt = authorization.begin({
    key,
    method: "oauth",
    interaction: {
      notify(notice) {
        const current = sessions.get(id) ?? {};
        sessions.set(id, { ...current, url: notice.url ?? current.url, code: notice.code ?? current.code, status: "pending" });
        if (notice.url) resolveUrl({ url: notice.url });
      },
      prompt(prompt) {
        const answer = answerPrompt(prompt);
        if (answer !== undefined) return Promise.resolve(answer);
        if (prompt.signal === undefined) {
          return Promise.reject(new Error(prompt.message || "这个登录步骤需要在认证页里完成"));
        }
        return new Promise((_resolve, reject) => {
          const fail = () => reject(new Error("authorization prompt withdrawn"));
          if (prompt.signal.aborted) fail();
          else prompt.signal.addEventListener("abort", fail, { once: true });
        });
      },
    },
  }).then(async (outcome) => {
    sessions.set(id, { status: outcome.status === "authorized" ? "authorized" : "cancelled" });
    resolveUrl({});
  }).catch((error) => {
    sessions.set(id, { status: "error", error: error instanceof Error ? error.message : String(error) });
    resolveUrl({});
  });
  void attempt;
  const started = await Promise.race([
    urlReady,
    new Promise((resolve) => setTimeout(() => resolve({}), 8000)),
  ]);
  const session = sessions.get(id) ?? {};
  return { url: session.url ?? started.url ?? "", pending: session.status === "pending" };
}

function providerId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value) ? value : undefined;
}

async function grantPayload(ctx, id) {
  const record = await ctx.credentials.readRecord(credentialKey(PI_AI, id));
  if (record?.kind !== "grant" || !record.payload || typeof record.payload !== "object") {
    throw new Error("先完成这个提供商的 OAuth 登录，再拉取模型");
  }
  return record.payload;
}

async function currentPull(ctx, id) {
  const pull = await readPull(id);
  if (pull === undefined) return undefined;
  if (pull.expiresAt > Date.now()) return pull;
  await deletePull(id);
  await dropRoute(ctx, id);
  return undefined;
}

async function savePull(ctx, id, body) {
  const available = await fetchAccountModels(id, await grantPayload(ctx, id));
  const known = new Map(available.map((model) => [model.id, model]));
  const chosen = Array.isArray(body.models) ? body.models.filter((modelId) => typeof modelId === "string" && known.has(modelId)) : [];
  if (chosen.length === 0) throw new Error("至少选择一个从该 OAuth 账号拉到的模型");
  const expiresAt = Number(body.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("过期时间要晚于现在");
  if (expiresAt > Date.now() + 366 * 24 * 60 * 60 * 1000) throw new Error("过期时间不能超过一年");
  const chat = chosen.map((modelId) => known.get(modelId)).filter((model) => model.role === "chat");
  if (chat.length === 0) throw new Error("至少选择一个对话模型。生图和生视频模型不会替换当前对话。");
  await ctx.settings.mutate(SETTINGS, [{
    op: "set",
    path: ["providers", id, "models"],
    value: chat.map(modelProfile),
  }]);
  const pull = {
    models: chat,
    media: available.filter((model) => model.role === "image" || model.role === "video"),
    expiresAt,
  };
  await writePull(id, pull);
  return pull;
}

function modelProfile(model) {
  const entry = { id: model.id, name: model.name };
  if (Number.isInteger(model.contextWindow) && model.contextWindow > 0) entry.contextWindow = model.contextWindow;
  if (Array.isArray(model.input) && model.input.length > 0) entry.input = model.input;
  if (model.reasoningEfforts && typeof model.reasoningEfforts === "object") entry.reasoningEfforts = model.reasoningEfforts;
  return entry;
}

async function dropRoute(ctx, id) {
  try {
    await ctx.settings.mutate(SETTINGS, [{ op: "unset", path: ["providers", id] }]);
  } catch (error) {
    ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
  }
}

function answerPrompt(prompt) {
  if (prompt.signal !== undefined) return undefined;
  if (prompt.kind === "select") {
    const options = prompt.options ?? [];
    const browser = options.find((option) => option.id === "browser" || /browser/i.test(option.label));
    return (browser ?? options[0])?.id;
  }
  if (prompt.kind === "text" && /\bblank\b|留空|optional/i.test(prompt.message ?? "")) return "";
  return undefined;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed : {};
}
