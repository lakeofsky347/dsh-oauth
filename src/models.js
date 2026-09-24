/**
 * Model lists taken from the signed-in OAuth account.
 * These requests do not consult the adapter catalog.
 */

import { qwenEndpoint } from "./qwen.js";

const JSON_HEADERS = { accept: "application/json" };

/**
 * Chat models stay in the conversation picker. Image and video models are
 * stored beside the pull and used by tools, so the session model does not change.
 * Embedding, speech, and moderation rows are dropped.
 * @param {unknown} body
 * @returns {{ id: string, name: string, role: "chat" | "image" | "video" }[]}
 */
export function parseModelList(body) {
  const items = [];
  collectItems(body, items);
  const seen = new Set();
  const models = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const info = item.info && typeof item.info === "object" ? item.info : item;
    if (info.hidden === true || item.hidden === true) continue;
    const id = firstString(info.id, info.slug, info.model, item.id, item.slug, item.model);
    if (id === undefined || seen.has(id)) continue;
    const role = classifyModel(id, info);
    if (role === "skip") continue;
    seen.add(id);
    const name = firstString(info.name, info.display_name, info.title, item.name) ?? id;
    const model = { id, name, role };
    const contextWindow = positiveInt(info.context_window, info.contextWindow, item.context_window);
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    if (role === "chat") {
      const reasoningEfforts = reasoningEffortsOf(info.reasoning_efforts ?? info.reasoningEfforts ?? item.reasoning_efforts);
      if (reasoningEfforts !== undefined) model.reasoningEfforts = reasoningEfforts;
    }
    models.push(model);
  }
  return models;
}

const IMAGE_PREFERENCE = ["grok-imagine-image-2.0", "grok-imagine-image"];
const VIDEO_PREFERENCE = ["grok-imagine-video-1.5", "grok-imagine-video"];

/**
 * One current image model and one current video model.
 * Older aliases stay out of the pull list.
 * @param {{ id: string, name: string, role: string }[]} models
 */
export function preferredMedia(models) {
  return [
    pickMedia(models, "image", IMAGE_PREFERENCE, { id: "grok-imagine-image-2.0", name: "Grok Imagine Image" }),
    pickMedia(models, "video", VIDEO_PREFERENCE, { id: "grok-imagine-video-1.5", name: "Grok Imagine Video" }),
  ];
}

function pickMedia(models, role, order, fallback) {
  for (const id of order) {
    const found = models.find((model) => model.role === role && model.id === id);
    if (found) return found;
  }
  return models.find((model) => model.role === role) ?? { ...fallback, role };
}

function collectItems(body, items) {
  if (Array.isArray(body)) {
    items.push(...body);
    return;
  }
  if (!body || typeof body !== "object") return;
  for (const key of ["models", "data", "items"]) {
    if (Array.isArray(body[key])) items.push(...body[key]);
  }
  if (items.length > 0) return;
  for (const value of Object.values(body)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const info = value.info && typeof value.info === "object" ? value.info : value;
    if (typeof info.id === "string" || typeof info.model === "string") items.push(value);
  }
}

function classifyModel(id, info) {
  const blob = `${id} ${info.name ?? ""} ${info.description ?? ""}`.toLowerCase();
  if (/imagine-video|\bvideo\b|sora|veo/.test(blob)) return "video";
  if (/imagine-image|dall-e|gpt-image|image-gen|flux|aurora/.test(blob)) return "image";
  if (/embed|moderation|whisper|transcri|\btts\b|realtime|speech/.test(blob)) return "skip";
  return "chat";
}

/**
 * @param {string} provider
 * @param {Record<string, unknown>} payload OAuth grant payload. `access` is the bearer token.
 * @returns {Promise<{ id: string, name: string }[]>}
 */
export async function fetchAccountModels(provider, payload) {
  const access = typeof payload.access === "string" ? payload.access : "";
  if (access.length === 0) throw new Error("这次登录里没有 access token，无法拉取模型");
  const request = requestFor(provider, access, payload);
  const response = await fetch(request.url, {
    headers: request.headers,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${provider} 模型列表返回 ${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${provider} 模型列表不是 JSON`);
  }
  let models = parseModelList(body);
  if (provider === "xai") models = await withGrokMedia(models, access);
  if (models.length === 0) throw new Error(`${provider} 的 OAuth 账号没有返回可用模型`);
  return models;
}

async function withGrokMedia(chatModels, access) {
  const chats = chatModels
    .filter((model) => model.role === "chat")
    .map((model) => ({ ...model, input: model.input ?? ["text", "image"] }));
  let listed = [];
  try {
    const response = await fetch("https://api.x.ai/v1/models", {
      headers: { ...JSON_HEADERS, authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) listed = parseModelList(await response.json());
  } catch {
    /* Imagine ids below still name the current image and video models. */
  }
  const seen = new Set(chats.map((model) => model.id));
  return [...chats, ...preferredMedia(listed).filter((model) => !seen.has(model.id))];
}

function positiveInt(...values) {
  for (const value of values) {
    if (Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

function reasoningEffortsOf(rows) {
  if (!Array.isArray(rows)) return undefined;
  const efforts = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const level = firstString(row.id, row.value);
    const wire = firstString(row.value, row.id);
    if (level === undefined || wire === undefined) continue;
    if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) continue;
    efforts[level] = wire;
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined;
}

/**
 * @param {string} provider
 * @param {string} access
 * @param {Record<string, unknown>} payload
 */
function requestFor(provider, access, payload) {
  const bearer = { ...JSON_HEADERS, authorization: `Bearer ${access}` };
  if (provider === "openai-codex") {
    const headers = { ...bearer };
    const accountId = chatgptAccountId(access) ?? (typeof payload.accountId === "string" ? payload.accountId : undefined);
    if (accountId) headers["chatgpt-account-id"] = accountId;
    return { url: "https://chatgpt.com/backend-api/codex/models", headers };
  }
  if (provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/models",
      headers: { ...bearer, "anthropic-version": "2023-06-01" },
    };
  }
  if (provider === "openrouter") {
    return { url: "https://openrouter.ai/api/v1/models", headers: bearer };
  }
  if (provider === "xai") {
    return { url: "https://cli-chat-proxy.grok.com/v1/models", headers: bearer };
  }
  if (provider === "kimi-coding") {
    return { url: "https://api.kimi.com/coding/v1/models", headers: bearer };
  }
  if (provider === "qwen") {
    return { url: `${qwenEndpoint(payload.resourceUrl)}/models`, headers: bearer };
  }
  if (provider === "github-copilot") {
    return {
      url: `${copilotApiBase(access)}/models`,
      headers: {
        ...bearer,
        "user-agent": "GitHubCopilotChat/0.35.0",
        "editor-version": "vscode/1.107.0",
        "editor-plugin-version": "copilot-chat/0.35.0",
        "copilot-integration-id": "vscode-chat",
        "x-github-api-version": "2026-06-01",
      },
    };
  }
  throw new Error(`${provider} 还没有 OAuth 模型列表地址`);
}

function chatgptAccountId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function copilotApiBase(token) {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (match?.[1]) return `https://${match[1].replace(/^proxy\./, "api.")}`;
  return "https://api.individual.githubcopilot.com";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
