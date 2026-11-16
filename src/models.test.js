import assert from "node:assert/strict";
import test from "node:test";
import { codexModelsUrl, fetchAccountModels, modelListRequest, parseModelList, preferredMedia } from "./models.js";
import { OAuthRequestError, withGrantRecovery } from "./request-errors.js";

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

  assert.equal(modelListRequest("openrouter", "token").url, "https://openrouter.ai/api/v1/models/user");
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
  }, "xai");
  assert.deepEqual(models, [{
    id: "grok-4.7-build-fast",
    name: "Grok 4.7 Fast",
    role: "chat",
    contextWindow: 500000,
    input: ["text", "image"],
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
  assert.equal(noEffort.reasoningEfforts, false);
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
    { id: "claude-a", name: "Claude A", role: "chat", contextWindow: 200000, reasoningEfforts: { high: "high", max: "max" }, source: 'account', entitlement: 'account' },
    { id: "claude-b", name: "Claude B", role: "chat", reasoningEfforts: false, source: 'account', entitlement: 'account' },
  ]);
});

test("Codex visibility, modalities, and explicit empty reasoning survive catalog parsing", () => {
  const models = parseModelList({ models: [
    {
      slug: "codex-visible",
      display_name: "Codex Visible",
      visibility: "list",
      context_window: 272000,
      max_context_window: 400000,
      input_modalities: ["text", "image", "audio"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }],
    },
    { slug: "codex-hide", visibility: "hide" },
    { slug: "codex-none", visibility: "none" },
    { slug: "codex-off", visibility: "list", supported_reasoning_levels: [{ effort: "none" }] },
    { slug: "codex-empty", visibility: "list", supported_reasoning_levels: [] },
  ] });
  assert.deepEqual(models, [
    {
      id: "codex-visible", name: "Codex Visible", role: "chat", contextWindow: 272000,
      input: ["text", "image"], reasoningEfforts: { low: "low", max: "max" },
    },
    { id: "codex-off", name: "codex-off", role: "chat", reasoningEfforts: false },
    { id: "codex-empty", name: "codex-empty", role: "chat", reasoningEfforts: false },
  ]);
});

test("Copilot account catalog honors picker availability and retains declared capabilities", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [
    {
      id: "copilot-chat", name: "Copilot Chat", model_picker_enabled: true, policy: { state: "enabled" },
      capabilities: {
        type: "chat",
        limits: { max_context_window_tokens: 200000, max_prompt_tokens: 150000, max_output_tokens: 32000 },
        supports: { vision: true, tool_calls: true, reasoning_effort: ["low", "medium", "high"] },
      },
    },
    { id: "copilot-disabled", model_picker_enabled: true, policy: { state: "disabled" }, capabilities: { type: "chat" } },
    { id: "copilot-no-tools", model_picker_enabled: true, capabilities: { type: "chat", supports: { tool_calls: false } } },
    { id: "copilot-hidden", model_picker_enabled: false, policy: { state: "enabled" }, capabilities: { type: "chat" } },
    { id: "copilot-embedding", model_picker_enabled: true, capabilities: { type: "embeddings" } },
    { id: "copilot-completion", model_picker_enabled: true, capabilities: { type: "completion" } },
  ] }), { status: 200 }));
  assert.deepEqual(await fetchAccountModels("github-copilot", { access: "token" }), [{
    id: "copilot-chat", name: "Copilot Chat", role: "chat", contextWindow: 200000, maxTokens: 32000,
    input: ["text", "image"], reasoningEfforts: { low: "low", medium: "medium", high: "high" },
    tools: true, source: 'account', entitlement: 'account',
  }]);
});

test("Copilot enabled-policy fallback applies only to Individual accounts with an empty picker", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [
    {
      id: "individual-enabled", model_picker_enabled: false, policy: { state: "enabled" },
      capabilities: { type: "chat", supports: { vision: false, tool_calls: true, reasoning_effort: ["none"] } },
    },
    { id: "individual-disabled", model_picker_enabled: false, policy: { state: "disabled" }, capabilities: { type: "chat" } },
    { id: "individual-unknown", model_picker_enabled: false, capabilities: { type: "chat" } },
  ] }), { status: 200 }));
  assert.deepEqual(await fetchAccountModels("github-copilot", { access: "token" }), [{
    id: "individual-enabled", name: "individual-enabled", role: "chat", input: ["text"], reasoningEfforts: false,
    tools: true, source: 'account', entitlement: 'account',
  }]);
  await assert.rejects(fetchAccountModels("github-copilot", {
    access: "token", apiBase: "https://api.business.githubcopilot.com",
  }), /没有返回可用模型/);
});

test("undeclared chat input is vision only for xAI, and explicit modalities still win", () => {
  const [grok] = parseModelList({ data: [{ id: "grok-4.7-build-fast" }] }, "xai");
  assert.deepEqual(grok.input, ["text", "image"]);

  const explicit = parseModelList({ data: [
    { id: "grok-text", input: ["text"] },
    { id: "grok-blind", capabilities: { supports: { vision: false } } },
    { id: "grok-see", input_modalities: ["image", "audio"] },
    { id: "claude-blind", capabilities: { image_input: { supported: false } } },
    { id: "grok-imagine-image-2.0" },
  ] }, "xai");
  assert.deepEqual(explicit.map((model) => model.input), [
    ["text"], ["text"], ["text", "image"], ["text"], undefined,
  ]);

  const [omitted, claude, routerText, routerVision, kimi] = [
    ...parseModelList({ data: [{ id: "claude-undeclared" }] }, "anthropic"),
    ...parseModelList({ data: [{ id: "claude-new", capabilities: { image_input: { supported: true } } }] }, "anthropic"),
    ...parseModelList({ data: [{ id: "vendor/text", architecture: { input_modalities: ["text"], modality: "text+image->text" } }] }, "openrouter"),
    ...parseModelList({ data: [{ id: "vendor/vision", architecture: { modality: "text+image->text" } }] }, "openrouter"),
    ...parseModelList({ data: [{ id: "kimi-new" }] }, "kimi-coding"),
  ];
  assert.equal(omitted.input, undefined);
  assert.deepEqual(claude.input, ["text", "image"]);
  assert.deepEqual(routerText.input, ["text"]);
  assert.deepEqual(routerVision.input, ["text", "image"]);
  assert.equal(kimi.input, undefined);
});

test("missing output or reasoning metadata stays unknown rather than becoming a generic capability", () => {
  assert.deepEqual(parseModelList({ data: [
    { id: "known-output", max_output_tokens: 16384, input_modalities: ["text"] },
    { id: "unknown-output", max_output_tokens: "32768" },
    { id: "prompt-only", capabilities: { limits: { max_prompt_tokens: 64000 } } },
  ] }), [
    { id: "known-output", name: "known-output", role: "chat", maxTokens: 16384, input: ["text"] },
    { id: "unknown-output", name: "unknown-output", role: "chat" },
    { id: "prompt-only", name: "prompt-only", role: "chat" },
  ]);
});

test("refreshed upstream auth headers and base URLs reach catalog requests", () => {
  const copilot = modelListRequest("github-copilot", "token", {
    apiBase: "https://copilot-api.example.test///",
    requestHeaders: { "User-Agent": "upstream-client", "X-GitHub-Api-Version": "upstream-version" },
  });
  assert.equal(copilot.url, "https://copilot-api.example.test/models");
  assert.equal(copilot.headers["user-agent"], "upstream-client");
  assert.equal(copilot.headers["x-github-api-version"], "upstream-version");
  assert.equal(copilot.headers.authorization, "Bearer token");
  const anthropic = modelListRequest("anthropic", "token", {
    requestHeaders: { "Anthropic-Beta": "upstream-oauth-beta", "User-Agent": "upstream-claude" },
  });
  assert.equal(anthropic.headers["anthropic-beta"], "upstream-oauth-beta");
  assert.equal(anthropic.headers["user-agent"], "upstream-claude");
  assert.equal(modelListRequest("kimi-coding", "token", { apiBase: "https://kimi.example.test/v1/" }).url,
    "https://kimi.example.test/v1/models");
  assert.equal(modelListRequest("xai", "token", { apiBase: "https://grok.example.test/v1/" }).url,
    "https://grok.example.test/v1/models");
  assert.equal(new URL(modelListRequest("openai-codex", "token", {
    apiBase: "https://chatgpt.com/backend-api/codex/responses",
  }).url).pathname, "/backend-api/codex/models");
});

test("preferred media never invents a model absent from an account catalog", () => {
  assert.deepEqual(preferredMedia([]), []);
  assert.deepEqual(preferredMedia([{ id: "grok-imagine-image", name: "Image", role: "image" }]), [
    { id: "grok-imagine-image", name: "Image", role: "image" },
  ]);
});

test("Grok media catalog failures keep only models returned by the OAuth catalog", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    if (String(url).startsWith("https://api.x.ai/")) return new Response("denied", { status: 401 });
    return new Response(JSON.stringify({ data: [{ id: "grok-chat" }] }), { status: 200 });
  });
  assert.deepEqual(await fetchAccountModels("xai", { access: "token" }), [
    { id: "grok-chat", name: "grok-chat", role: "chat", input: ["text", "image"], source: 'account', entitlement: 'account' },
  ]);
  assert.equal(requests.length, 2);
});

test("Grok media listed by OAuth remains available when the separate media endpoint is unavailable", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("https://api.x.ai/")) throw new Error("offline");
    return new Response(JSON.stringify({ data: [{ id: "grok-chat" }, { id: "grok-imagine-image-2.0" }] }), { status: 200 });
  });
  assert.deepEqual((await fetchAccountModels("xai", { access: "token" })).map((model) => model.id), [
    "grok-chat", "grok-imagine-image-2.0",
  ]);
});

test("a primary model catalog rejection carries structured status without retaining its token response", async (t) => {
  const token = "sensitive-token-that-must-not-be-displayed";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: { code: "permission_denied", message: `Do not reveal ${token}` }, access_token: token,
  }), { status: 403 }));
  await assert.rejects(fetchAccountModels("openrouter", { access: "signed-in" }), (error) => {
    assert.ok(error instanceof OAuthRequestError);
    assert.equal(error.provider, "openrouter");
    assert.equal(error.status, 403);
    assert.equal(error.authenticationRejected, false);
    assert.equal(error.code, "permission_denied");
    assert.doesNotMatch(String(error), new RegExp(token));
    assert.doesNotMatch(JSON.stringify(error), new RegExp(token));
    return true;
  });
});

test("an xAI primary catalog bad-credentials rejection rebuilds the request with one renewed grant", async (t) => {
  const old = { access: "old", expires: Date.now() + 3600000 };
  const renewed = { access: "renewed", expires: Date.now() + 3600000 };
  const requests = [];
  const resolutions = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).startsWith("https://api.x.ai/")) return new Response("no media permission", { status: 403 });
    requests.push(options.headers.authorization);
    if (options.headers.authorization === "Bearer old") return new Response(JSON.stringify({
      code: "unauthenticated:bad-credentials", error: "The OAuth2 access token could not be validated.",
    }), { status: 403 });
    return new Response(JSON.stringify({ data: [{ id: "grok-chat" }] }), { status: 200 });
  });
  const models = await withGrantRecovery("xai", async (provider, options) => {
    resolutions.push({ provider, options });
    return options ? renewed : old;
  }, (grant) => fetchAccountModels("xai", grant));
  assert.deepEqual(models.map((model) => model.id), ["grok-chat"]);
  assert.deepEqual(requests, ["Bearer old", "Bearer renewed"]);
  assert.deepEqual(resolutions[1], { provider: "xai", options: { rejectedGrant: old } });
  assert.equal(resolutions.length, 2);
});

test("an optional Grok media catalog 401 does not refresh a grant whose primary catalog succeeded", async (t) => {
  let resolveCalls = 0;
  t.mock.method(globalThis, "fetch", async (url) => String(url).startsWith("https://api.x.ai/")
    ? new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 })
    : new Response(JSON.stringify({ data: [{ id: "grok-chat" }] }), { status: 200 }));
  const models = await withGrantRecovery("xai", async () => { resolveCalls += 1; return { access: "signed-in" }; },
    (grant) => fetchAccountModels("xai", grant));
  assert.equal(resolveCalls, 1);
  assert.deepEqual(models.map((model) => model.id), ["grok-chat"]);
});

test("an authentication rejection on a later Anthropic page retries the read-only catalog from its first page", async (t) => {
  const requests = [];
  let resolveCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const after = new URL(url).searchParams.get("after_id");
    requests.push({ after, authorization: options.headers.authorization });
    if (!after) return new Response(JSON.stringify({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" }));
    if (options.headers.authorization === "Bearer old") return new Response(JSON.stringify({ error: { type: "authentication_error" } }), { status: 401 });
    return new Response(JSON.stringify({ data: [{ id: "claude-b" }], has_more: false }));
  });
  const models = await withGrantRecovery("anthropic", async () => ({ access: ++resolveCalls === 1 ? "old" : "renewed" }),
    (grant) => fetchAccountModels("anthropic", grant));
  assert.deepEqual(models.map((model) => model.id), ["claude-a", "claude-b"]);
  assert.deepEqual(requests, [
    { after: null, authorization: "Bearer old" },
    { after: "claude-a", authorization: "Bearer old" },
    { after: null, authorization: "Bearer renewed" },
    { after: "claude-a", authorization: "Bearer renewed" },
  ]);
  assert.equal(resolveCalls, 2);
});
