import assert from "node:assert/strict";
import test from "node:test";
import { codexModelsUrl, fetchAccountModels, modelListRequest, parseModelList, preferredMedia } from "./models.js";

test("codex model list URL includes client_version", () => {
  const url = new URL(codexModelsUrl());
  assert.equal(url.origin + url.pathname, "https://chatgpt.com/backend-api/codex/models");
  assert.equal(url.searchParams.get("client_version"), "0.156.1");
});

test("each OAuth model list sends the fields that provider requires", () => {
  const codex = modelListRequest("openai-codex", "header.payload.sig");
  assert.equal(new URL(codex.url).searchParams.get("client_version"), "0.156.1");

  const claude = modelListRequest("anthropic", "token");
  assert.equal(claude.headers["anthropic-version"], "2023-06-01");
  assert.equal(claude.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(new URL(claude.url).searchParams.get("limit"), "1000");

  const kimi = modelListRequest("kimi-coding", "token");
  assert.equal(kimi.url, "https://api.kimi.com/coding/v1/models");
  assert.equal(kimi.headers["user-agent"], "KimiCLI/1.0");

  const copilot = modelListRequest("github-copilot", "tid=1;proxy-ep=proxy.individual.githubcopilot.com");
  assert.equal(copilot.url, "https://api.individual.githubcopilot.com/models");
  assert.equal(copilot.headers["copilot-integration-id"], "vscode-chat");
  assert.equal(copilot.headers["x-github-api-version"], "2026-06-01");

  const qwen = modelListRequest("qwen", "token", { resourceUrl: "https://portal.qwen.ai/v1" });
  assert.equal(qwen.url, "https://portal.qwen.ai/v1/models");

  assert.equal(modelListRequest("openrouter", "token").url, "https://openrouter.ai/api/v1/models");
  assert.equal(modelListRequest("xai", "token").url, "https://cli-chat-proxy.grok.com/v1/models");
});

test("parseModelList reads id, slug, and display name without a catalog", () => {
  const models = parseModelList({
    models: [{ slug: "gpt-5.4", title: "GPT 5.4" }, { id: "gpt-5.4" }],
    data: [{ id: "claude-sonnet", display_name: "Claude Sonnet" }],
  });
  assert.deepEqual(models, [
    { id: "gpt-5.4", name: "GPT 5.4", role: "chat" },
    { id: "claude-sonnet", name: "Claude Sonnet", role: "chat" },
  ]);
});

test("parseModelList ignores entries that have no id", () => {
  assert.deepEqual(parseModelList({ data: [{ name: "nameless" }, { id: "kept" }] }), [
    { id: "kept", name: "kept", role: "chat" },
  ]);
});

test("subscription model maps keep grok-4.7-build-fast and drop hidden or embedding rows", () => {
  const models = parseModelList({
    data: [
      {
        id: "grok-4.7-build-fast",
        name: "Grok 4.7 Fast",
        context_window: 500000,
        reasoning_efforts: [{ id: "xhigh", value: "xhigh" }, { id: "high", value: "high" }],
      },
      { id: "grok-embed", name: "Embed" },
      { id: "grok-2", name: "Old", hidden: true },
    ],
  });
  assert.deepEqual(models, [{
    id: "grok-4.7-build-fast",
    name: "Grok 4.7 Fast",
    role: "chat",
    contextWindow: 500000,
    reasoningEfforts: { xhigh: "xhigh", high: "high" },
  }]);
});

test("reasoning levels stay the ones each account advertises", () => {
  const [codex] = parseModelList({
    models: [{
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      supported_reasoning_levels: [
        { effort: "low", description: "low" },
        { effort: "high", description: "high" },
        { effort: "xhigh", description: "extra" },
        { effort: "ultra", description: "not a harness level" },
      ],
    }],
  });
  assert.deepEqual(codex.reasoningEfforts, { low: "low", high: "high", xhigh: "xhigh" });

  const [openai] = parseModelList({
    data: [{
      id: "gpt-5.4",
      supported_reasoning_levels: [{ effort: "none" }, { effort: "medium" }],
    }],
  });
  assert.deepEqual(openai.reasoningEfforts, { off: "none", medium: "medium" });

  const [plain] = parseModelList({ data: [{ id: "claude-sonnet", display_name: "Claude" }] });
  assert.equal(plain.reasoningEfforts, undefined);
});

test("anthropic capability flags become reasoning levels and max_input_tokens the context window", () => {
  const [claude, noEffort] = parseModelList({
    data: [
      {
        type: "model",
        id: "claude-opus",
        display_name: "Claude Opus",
        max_input_tokens: 200000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            max: { supported: true },
            xhigh: { supported: false },
          },
          thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
        },
      },
      {
        type: "model",
        id: "claude-haiku",
        display_name: "Claude Haiku",
        capabilities: { effort: { supported: false, low: { supported: true } } },
      },
    ],
    has_more: false,
  });
  assert.equal(claude.contextWindow, 200000);
  assert.deepEqual(claude.reasoningEfforts, { low: "low", medium: "medium", high: "high", max: "max" });
  assert.equal(noEffort.reasoningEfforts, undefined);
});

test("preferred media keeps the current image and video models", () => {
  const media = preferredMedia([
    { id: "grok-imagine-image", name: "old image", role: "image" },
    { id: "grok-imagine-image-quality", name: "quality", role: "image" },
    { id: "grok-imagine-image-2.0", name: "Grok Imagine Image", role: "image" },
    { id: "grok-imagine-video", name: "old video", role: "video" },
    { id: "grok-imagine-video-1.5", name: "Grok Imagine Video", role: "video" },
    { id: "grok-4.7", name: "Grok 4.7", role: "chat" },
  ]);
  assert.deepEqual(media.map((model) => model.id), ["grok-imagine-image-2.0", "grok-imagine-video-1.5"]);
});

test("anthropic pull follows has_more pages and keeps effort levels", async (t) => {
  const pages = {
    first: {
      data: [{
        id: "claude-a",
        display_name: "Claude A",
        max_input_tokens: 200000,
        capabilities: { effort: { supported: true, high: { supported: true }, max: { supported: true } } },
      }],
      has_more: true,
      last_id: "claude-a",
    },
    second: {
      data: [{ id: "claude-b", display_name: "Claude B", capabilities: { effort: { supported: false } } }],
      has_more: false,
      last_id: "claude-b",
    },
  };
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    const body = new URL(url).searchParams.get("after_id") === "claude-a" ? pages.second : pages.first;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const models = await fetchAccountModels("anthropic", { access: "token" });
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]).searchParams.get("limit"), "1000");
  assert.deepEqual(models, [
    { id: "claude-a", name: "Claude A", role: "chat", contextWindow: 200000, reasoningEfforts: { high: "high", max: "max" } },
    { id: "claude-b", name: "Claude B", role: "chat" },
  ]);
});
