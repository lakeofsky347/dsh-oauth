import assert from "node:assert/strict";
import test from "node:test";
import { codexModelsUrl, modelListRequest, parseModelList, preferredMedia } from "./models.js";

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
