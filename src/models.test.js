import assert from "node:assert/strict";
import test from "node:test";
import { parseModelList, preferredMedia } from "./models.js";

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
