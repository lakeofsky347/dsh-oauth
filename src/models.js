/**
 * Model lists from a signed-in account, supplier catalog, or explicitly marked
 * installed catalog. Catalog availability does not prove subscription coverage.
 */

import { qwenEndpoint } from "./qwen.js";
import { OAuthRequestError } from "./request-errors.js";
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { getProviderDefinition } from './catalog.js';

const JSON_HEADERS = { accept: "application/json" };
const CODEX_CLIENT_VERSION = "0.156.1";

/** Codex model catalog requires this query; a missing client_version is HTTP 400. */
export function codexModelsUrl(clientVersion = CODEX_CLIENT_VERSION) {
  const url = new URL("https://chatgpt.com/backend-api/codex/models");
  url.searchParams.set("client_version", clientVersion);
  return url.toString();
}

/**
 * Chat models stay in the conversation picker. Image and video models are
 * stored beside the pull and used by tools, so the session model does not change.
 * Embedding, speech, and moderation rows are dropped.
 * @param {unknown} body
 * @param {string} [provider] OAuth provider id. Selects the policy used when a chat row declares no input.
 * @returns {{ id: string, name: string, role: "chat" | "image" | "video", contextWindow?: number, maxTokens?: number, input?: string[], reasoningEfforts?: false | Record<string, string> }[]}
 */
export function parseModelList(body, provider) {
  const items = [];
  collectItems(body, items);
  const seen = new Set();
  const models = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const info = item.info && typeof item.info === "object" ? item.info : item;
    if (info.hidden === true || item.hidden === true ||
        [info.visibility, item.visibility].some((visibility) => visibility === "hide" || visibility === "none")) continue;
    const id = firstString(info.id, info.slug, info.model, item.id, item.slug, item.model);
    if (id === undefined || seen.has(id)) continue;
    const role = classifyModel(id, info);
    if (role === "skip") continue;
    seen.add(id);
    const name = firstString(info.name, info.display_name, info.title, item.name) ?? id;
    const model = { id, name, role };
    const contextWindow = positiveInt(
      info.context_window,
      info.contextWindow,
      info.context_length,
      info.max_input_tokens,
      item.context_window,
      item.max_input_tokens,
      info.capabilities?.limits?.max_context_window_tokens,
      item.capabilities?.limits?.max_context_window_tokens,
      info.max_context_window,
      item.max_context_window,
    );
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    if (role === "chat") {
      const maxTokens = positiveInt(
        info.max_output_tokens,
        info.maxTokens,
        info.top_provider?.max_completion_tokens,
        item.max_output_tokens,
        item.maxTokens,
        info.capabilities?.limits?.max_output_tokens,
        item.capabilities?.limits?.max_output_tokens,
      );
      if (maxTokens !== undefined) model.maxTokens = maxTokens;
      const input = modelInput(info, item, provider);
      if (input !== undefined) model.input = input;
      const reasoningEfforts = reasoningEffortsFrom(info, item);
      if (reasoningEfforts !== undefined) model.reasoningEfforts = reasoningEfforts;
      const reasoning = [info.reasoning, info.capabilities?.reasoning, item.reasoning].find(value => typeof value === 'boolean');
      if (reasoning !== undefined) model.reasoning = reasoning;
      const tools = [info.capabilities?.supports?.tool_calls, info.supports_tools, info.tool_calling, info.capabilities?.tool_calling, info.capabilities?.tool_calling?.supported].find(value => typeof value === 'boolean');
      if (tools !== undefined) model.tools = tools;
      else if (Array.isArray(info.supported_parameters)) model.tools = info.supported_parameters.includes('tools');
    }
    const output = outputModalities(info) ?? outputModalities(item);
    if (output !== undefined) model.output = output;
    models.push(model);
  }
  return models;
}

const IMAGE_PREFERENCE = ["grok-imagine-image-2.0", "grok-imagine-image"];
const VIDEO_PREFERENCE = ["grok-imagine-video-1.5", "grok-imagine-video"];

/**
 * Prefer one image model and one video model from the returned catalog.
 * A missing media role stays absent.
 * @param {{ id: string, name: string, role: string }[]} models
 */
export function preferredMedia(models) {
  return [
    pickMedia(models, "image", IMAGE_PREFERENCE),
    pickMedia(models, "video", VIDEO_PREFERENCE),
  ].filter((model) => model !== undefined);
}

function pickMedia(models, role, order) {
  for (const id of order) {
    const found = models.find((model) => model.role === role && model.id === id);
    if (found) return found;
  }
  return models.find((model) => model.role === role);
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
  const type = info.capabilities?.type;
  if (type === "embedding" || type === "embeddings" || type === "completion") return "skip";
  // Input video and descriptions mentioning image tools do not make a chat
  // model a media generator. Explicit output modalities take precedence.
  const output = outputModalities(info);
  if (output?.includes('text')) return 'chat';
  if (output?.includes('video')) return 'video';
  if (output?.includes('image')) return 'image';
  if (output?.includes('audio')) return 'skip';
  const blob = `${id} ${info.name ?? ""}`.toLowerCase();
  if (/imagine-video|\bvideo\b|sora|veo/.test(blob)) return "video";
  if (/imagine-image|dall-e|gpt-image|image-gen|flux|aurora/.test(blob)) return "image";
  if (/embed|moderation|whisper|transcri|\btts\b|realtime|speech/.test(blob)) return "skip";
  return "chat";
}

/**
 * @param {string} provider
 * @param {Record<string, unknown>} payload OAuth grant payload. `access` is the bearer token.
 * @returns {Promise<ReturnType<typeof parseModelList>>}
 */
export async function fetchAccountModels(provider, payload) {
  const access = typeof payload.access === "string" ? payload.access : "";
  if (access.length === 0) throw new Error("这次登录里没有 access token，无法拉取模型");
  const definition = getProviderDefinition(provider, payload);
  if (definition?.catalogProvider && !definition.modelsURL) {
    const registry = builtinModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
    const installed = await registry.getProvider(definition.catalogProvider)?.getModels();
    if (!installed?.length) throw new Error('The installed provider catalog is unavailable.');
    const source = new Map(installed.map(model => [model.id, model]));
    return parseModelList(installed, provider).map(model => {
      const compat = modelCompatFrom(source.get(model.id)?.compat);
      return { ...model, ...(compat ? { compat } : {}), source: 'installed-catalog', entitlement: 'unknown' };
    });
  }
  const request = modelListRequest(provider, access, payload);
  let body = await fetchModelPage(provider, request.url, request.headers);
  // Anthropic pages its catalog: follow has_more / last_id until the list ends.
  if (provider === "anthropic") {
    const rows = Array.isArray(body?.data) ? [...body.data] : [];
    let page = body;
    for (let guard = 0; guard < 20 && page?.has_more === true && typeof page.last_id === "string"; guard++) {
      const next = new URL(request.url);
      next.searchParams.set("after_id", page.last_id);
      page = await fetchModelPage(provider, next.toString(), request.headers);
      if (Array.isArray(page?.data)) rows.push(...page.data);
    }
    body = { data: rows };
  }
  if (provider === "github-copilot") body = copilotAccountCatalog(body, request.url);
  let models = parseModelList(body, provider);
  if (provider === "xai") models = await withGrokMedia(models, access);
  if (models.length === 0) throw new Error(`${provider} 的 OAuth 账号没有返回可用模型`);
  return models.map(model => ({ ...model, source: definition?.modelSource ?? 'account', entitlement: definition?.entitlement ?? 'account' }));
}

async function fetchModelPage(provider, url, headers) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new OAuthRequestError(provider, response.status, text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${provider} 模型列表不是 JSON`);
  }
}

async function withGrokMedia(chatModels, access) {
  const chats = chatModels.filter((model) => model.role === "chat");
  const listed = chatModels.filter((model) => model.role === "image" || model.role === "video");
  try {
    const response = await fetch("https://api.x.ai/v1/models", {
      headers: { ...JSON_HEADERS, authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (response.ok) listed.push(...parseModelList(await response.json()));
  } catch {
    /* Preserve only media the account's successful catalog response listed. */
  }
  const seen = new Set(chats.map((model) => model.id));
  return [...chats, ...preferredMedia(listed).filter((model) => !seen.has(model.id))];
}

/** Copilot's picker and policy flags describe account availability, including its Individual-only fallback. */
function copilotAccountCatalog(body, requestUrl) {
  const rows = Array.isArray(body?.data) ? body.data.filter((item) =>
    item && typeof item === "object" && item.capabilities?.type === "chat" &&
    item.capabilities?.supports?.tool_calls !== false) : [];
  const picker = rows.filter((item) => item.model_picker_enabled === true && item.policy?.state !== "disabled");
  const individual = requestUrl === "https://api.individual.githubcopilot.com/models";
  return { data: picker.length > 0 || !individual ? picker : rows.filter((item) => item.policy?.state === "enabled") };
}

/**
 * Grok chat accepts images, but the xAI account catalog omits modalities.
 * Harness inherits an omitted `input` from the install catalog and otherwise
 * uses the route default `["text"]`, so an id that is not installed yet loses
 * vision. Other providers keep the omission: their catalogs mix text-only and
 * vision models, and inheritance is the per-model answer.
 */
const UNDECLARED_CHAT_INPUT = {
  xai: ["text", "image"],
};

/** Keep only input modalities the installed Harness can represent. */
function modelInput(info, item, provider) {
  for (const source of [info, item]) {
    const declared = declaredInput(source);
    if (declared !== undefined) return declared;
  }
  return UNDECLARED_CHAT_INPUT[provider];
}

/**
 * Every account catalog is read here. Codex and Qwen use `input_modalities`.
 * Copilot uses `capabilities.supports.vision`. Anthropic uses
 * `capabilities.image_input.supported`. OpenRouter nests the list under
 * `architecture`, or encodes it as `text+image->text`.
 */
function declaredInput(source) {
  if (!source || typeof source !== "object") return undefined;
  for (const modalities of [
    source.input_modalities,
    source.input,
    source.architecture?.input_modalities,
    source.architecture?.inputModalities,
  ]) {
    const input = modalityList(modalities);
    if (input !== undefined) return input;
  }
  const described = modalityList(modalityWords(source.architecture?.modality));
  if (described !== undefined) return described;
  for (const vision of [
    source.capabilities?.supports?.vision,
    source.capabilities?.image_input?.supported,
    source.capabilities?.vision,
  ]) {
    if (typeof vision === "boolean") return vision ? ["text", "image"] : ["text"];
  }
  return undefined;
}

function modalityList(modalities) {
  if (!Array.isArray(modalities)) return undefined;
  const seen = new Set(modalities.filter((value) => value === "text" || value === "image"));
  if (seen.size === 0) return undefined;
  return seen.has("image") ? ["text", "image"] : ["text"];
}

function modalityWords(value) {
  if (typeof value !== "string" || !value.includes("->")) return undefined;
  return value.split("->")[0].split(/[+,]/).map((part) => part.trim().toLowerCase());
}

function outputModalities(source) {
  if (!source || typeof source !== 'object') return undefined;
  const declared = source.output_modalities ?? source.output ?? source.architecture?.output_modalities;
  if (Array.isArray(declared)) return [...new Set(declared.filter(value => ['text', 'image', 'audio', 'video'].includes(value)))];
  const modality = source.architecture?.modality;
  if (typeof modality !== 'string' || !modality.includes('->')) return undefined;
  return [...new Set(modality.split('->')[1].split(/[+,]/).map(value => value.trim().toLowerCase()).filter(value => ['text', 'image', 'audio', 'video'].includes(value)))];
}

function positiveInt(...values) {
  for (const value of values) {
    if (Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** Vendor spellings that correspond to a harness thinking level. The stored value stays the vendor string. */
const THINKING_ALIASES = {
  off: "off",
  none: "off",
  disabled: "off",
  minimal: "minimal",
  min: "minimal",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  extra_high: "xhigh",
  "extra-high": "xhigh",
  max: "max",
};

/**
 * Levels the account catalog actually advertises.
 * Maps name only advertised levels. An explicit empty list or only off
 * becomes false, which disables inherited reasoning in the Harness catalog.
 * @param {object} info
 * @param {object} item
 */
export function reasoningEffortsFrom(info, item) {
  const efforts = {};
  for (const source of [info, item]) {
    if (!source || typeof source !== "object") continue;
    collectEffortRows(source.reasoning_efforts, efforts);
    collectEffortRows(source.reasoningEfforts, efforts);
    collectLevelList(source.supported_reasoning_levels, efforts);
    collectLevelList(source.supportedReasoningLevels, efforts);
    collectLevelList(source.supported_reasoning_efforts, efforts);
    collectLevelList(source.capabilities?.supports?.reasoning_effort, efforts);
    collectLevelList(source.effort?.supported_levels, efforts);
    collectThinkingMap(source.thinkingLevelMap, efforts);
    collectCapabilityMap(source.capabilities?.effort, efforts);
  }
  const levels = Object.keys(efforts);
  if (levels.length > 0) return levels.some((level) => level !== "off") ? efforts : false;
  for (const source of [info, item]) {
    if (!source || typeof source !== "object") continue;
    if (source.reasoning === false || source.reasoningEfforts === false || source.capabilities?.reasoning === false || source.capabilities?.effort?.supported === false) return false;
    for (const key of ["reasoning_efforts", "reasoningEfforts", "supported_reasoning_levels", "supportedReasoningLevels", "supported_reasoning_efforts"]) {
      if (Array.isArray(source[key]) && source[key].length === 0) return false;
    }
    if (Array.isArray(source.capabilities?.supports?.reasoning_effort) && source.capabilities.supports.reasoning_effort.length === 0) return false;
  }
  return undefined;
}

function collectThinkingMap(map, efforts) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  // pi-ai uses null to explicitly disable a level. A boolean reasoning flag
  // alone does not advertise a set of wire-level reasoning_effort values.
  for (const [level, wire] of Object.entries(map)) if (typeof wire === 'string') assignEffort(efforts, level, wire);
}

// Intersection with the oldest supported Harness compatProfile. Installed
// provider extras must not become unknown profile fields and reject the route.
const COMPAT_BOOLEANS = new Set([
  'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
  'supportsFinishReason', 'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages', 'supportsThinkingTokenBudget', 'supportsMaxOutputTokens',
  'supportsStrictMode', 'supportsLongCacheRetention', 'supportsEagerToolInputStreaming',
  'supportsCacheControlOnTools', 'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools',
]);
const COMPAT_ENUMS = {
  maxTokensField: ['max_completion_tokens', 'max_tokens'],
  thinkingFormat: ['openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'],
  thinkingTokenBudgetField: ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'],
  cacheControlFormat: ['anthropic'],
};
export function modelCompatFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (COMPAT_BOOLEANS.has(key) && typeof item === 'boolean') out[key] = item;
    else if (Object.hasOwn(COMPAT_ENUMS, key) && COMPAT_ENUMS[key].includes(item)) out[key] = item;
    else if (key === 'vllmPriority' && Number.isSafeInteger(item)) out[key] = item;
    else if (['chatTemplateKwargs', 'chatTemplateArgs'].includes(key) && item && typeof item === 'object' && !Array.isArray(item)) {
      const template = {};
      for (const [name, entry] of Object.entries(item).slice(0, 100)) {
        if (!/^[A-Za-z0-9_]{1,100}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
        if (entry === null || typeof entry === 'boolean' || typeof entry === 'number' && Number.isFinite(entry) || typeof entry === 'string' && entry.length <= 1000) template[name] = entry;
        else if (entry && typeof entry === 'object' && ['thinking.enabled', 'thinking.effort', 'thinking.budget'].includes(entry.$var)) {
          template[name] = { $var: entry.$var, ...(typeof entry.omitWhenOff === 'boolean' ? { omitWhenOff: entry.omitWhenOff } : {}) };
        }
      }
      if (Object.keys(template).length) out[key] = template;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function collectEffortRows(rows, efforts) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (typeof row === "string") {
      assignEffort(efforts, row, row);
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const levelName = firstString(row.id, row.effort, row.level);
    const wire = firstString(row.value, row.wire, row.effort, row.id);
    assignEffort(efforts, levelName, wire);
  }
}

function collectLevelList(rows, efforts) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (typeof row === "string") {
      assignEffort(efforts, row, row);
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const effort = firstString(row.effort, row.id, row.value);
    assignEffort(efforts, effort, effort);
  }
}

/**
 * Anthropic lists effort as an object of per-level flags:
 * capabilities.effort = { supported, low: { supported }, ..., max: { supported } }.
 */
function collectCapabilityMap(map, efforts) {
  if (!map || typeof map !== "object" || Array.isArray(map) || map.supported === false) return;
  for (const [key, value] of Object.entries(map)) {
    if (key === "supported") continue;
    if (value && typeof value === "object" && value.supported === true) assignEffort(efforts, key, key);
  }
}

function assignEffort(efforts, levelName, wire) {
  const level = thinkingLevel(levelName);
  const spelling = firstString(wire);
  if (level === undefined || spelling === undefined) return;
  if (efforts[level] !== undefined) return;
  efforts[level] = spelling;
}

function thinkingLevel(value) {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replaceAll(" ", "_");
  return Object.hasOwn(THINKING_ALIASES, key) ? THINKING_ALIASES[key] : undefined;
}

/**
 * @param {string} provider
 * @param {string} access
 * @param {Record<string, unknown>} payload
 */
export function modelListRequest(provider, access, payload = {}) {
  const authHeaders = new Headers({ ...JSON_HEADERS, authorization: `Bearer ${access}` });
  // Existing OAuth resolvers may attach protocol-specific auth headers. New
  // key connections use only the chosen credential and fixed catalog headers.
  const oauthHeaders = ['openai-codex', 'anthropic', 'xai', 'kimi-coding', 'qwen', 'github-copilot'].includes(provider) ? payload.requestHeaders : undefined;
  for (const [key, value] of Object.entries(oauthHeaders ?? {})) {
    if (typeof value === "string") authHeaders.set(key, value);
  }
  const bearer = Object.fromEntries(authHeaders);
  if (provider === "openai-codex") {
    const headers = { ...bearer };
    const accountId = chatgptAccountId(access) ?? (typeof payload.accountId === "string" ? payload.accountId : undefined);
    if (accountId) headers["chatgpt-account-id"] = accountId;
    return { url: codexModelsUrl(), headers };
  }
  if (provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headers: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        ...bearer,
      },
    };
  }
  if (provider === "openrouter") {
    return { url: "https://openrouter.ai/api/v1/models/user", headers: bearer };
  }
  if (provider === "xai") {
    return { url: modelsUrl(payload.apiBase, "https://cli-chat-proxy.grok.com/v1"), headers: bearer };
  }
  if (provider === "kimi-coding") {
    if (payload.region === 'cn' || payload.region === 'global') {
      return { url: `https://${payload.region === 'cn' ? 'api.kimi.com' : 'api.kimi.ai'}/coding/v1/models`, headers: { 'user-agent': 'KimiCLI/1.0', ...bearer } };
    }
    return {
      url: modelsUrl(payload.apiBase, "https://api.kimi.com/coding/v1"),
      headers: { "user-agent": "KimiCLI/1.0", ...bearer },
    };
  }
  if (provider === "qwen") {
    return { url: `${qwenEndpoint(payload.resourceUrl)}/models`, headers: bearer };
  }
  if (provider === "github-copilot") {
    return {
      url: modelsUrl(payload.apiBase, copilotApiBase(access)),
      headers: {
        "user-agent": "GitHubCopilotChat/0.35.0",
        "editor-version": "vscode/1.107.0",
        "editor-plugin-version": "copilot-chat/0.35.0",
        "copilot-integration-id": "vscode-chat",
        "x-github-api-version": "2026-06-01",
        ...bearer,
      },
    };
  }
  const definition = getProviderDefinition(provider, payload);
  if (definition?.modelsURL) return { url: definition.modelsURL, headers: { ...bearer, ...definition.modelHeaders } };
  throw new Error(`${provider} 还没有已核实的模型目录接口`);
}

function modelsUrl(apiBase, fallback) {
  const base = firstString(apiBase) ?? fallback;
  return `${base.replace(/\/+$/, "")}/models`;
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
