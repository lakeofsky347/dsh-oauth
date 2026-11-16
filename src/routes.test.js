import assert from "node:assert/strict";
import test from "node:test";
import { restoreRoute, writeRoute } from "./routes.js";

/** A revision-checked settings fake keeps tests at the public settings seam. */
function memorySettings(user = {}, mounted = true) {
  const state = { user: structuredClone(user), revision: 1 };
  const calls = [];
  return {
    state, calls,
    describe() { return mounted ? [{ ns: "llm-pi-ai", user: structuredClone(state.user), revision: state.revision }] : []; },
    async mutate(namespace, operations, revision) {
      assert.equal(namespace, "llm-pi-ai");
      assert.equal(revision, state.revision);
      calls.push(structuredClone(operations));
      for (const operation of operations) {
        let parent = state.user;
        for (const key of operation.path.slice(0, -1)) parent = parent[key] ??= {};
        const leaf = operation.path.at(-1);
        if (operation.op === "set") parent[leaf] = structuredClone(operation.value);
        else if (operation.op === "unset") delete parent[leaf];
        else assert.fail(`unexpected operation: ${operation.op}`);
      }
      state.revision += 1;
    },
  };
}

const models = [{ id: "pulled-chat", name: "Pulled Chat" }];
const qwenPlan = (list = models) => ({ displayName: "通义千问", api: "openai-completions", baseURL: "https://portal.qwen.ai/v1", apiKeyEnv: "QWEN_OAUTH_ACCESS", defaultInput: ["text"], models: list });

test("restoring a normal pull returns the previous model list and keeps unrelated provider settings", async () => {
  const original = { providers: { anthropic: { models: [{ id: "prior-chat" }], baseURL: "https://prior.example.test", custom: "keep" } } };
  const settings = memorySettings(original);
  const route = await writeRoute(settings, "anthropic", models);
  assert.deepEqual(settings.state.user.providers.anthropic.models, models);
  assert.deepEqual(settings.calls[0].map((operation) => operation.path), [["providers", "anthropic", "models"]]);
  await restoreRoute(settings, route);
  assert.deepEqual(settings.state.user, original);
});

test("repeated normal pulls retain the original model list as the restoration target", async () => {
  const original = { providers: { xai: { models: [{ id: "original" }], custom: "keep" } } };
  const settings = memorySettings(original);
  const first = await writeRoute(settings, "xai", models);
  const second = await writeRoute(settings, "xai", [{ id: "second-pull" }], undefined, first);
  await restoreRoute(settings, second);
  assert.deepEqual(settings.state.user, original);
});

test("a failed second pull rolls back to the first pull while expiry still restores the original models", async () => {
  const original = { providers: { xai: { models: [{ id: "original" }] } } };
  const settings = memorySettings(original);
  const first = await writeRoute(settings, "xai", models);
  const second = await writeRoute(settings, "xai", [{ id: "second-pull" }], undefined, first);
  await restoreRoute(settings, second.rollback);
  assert.deepEqual(settings.state.user.providers.xai.models, models);
  await restoreRoute(settings, first);
  assert.deepEqual(settings.state.user, original);
});

test("a plugin-created Qwen route is removed after repeated pulls while other providers remain", async () => {
  const original = { providers: { unrelated: { models: [{ id: "keep" }] } } };
  const settings = memorySettings(original);
  const first = await writeRoute(settings, "qwen", models, qwenPlan());
  assert.deepEqual(first.edits.map((edit) => edit.path), [["providers", "qwen"]]);
  const replacement = [{ id: "qwen-second" }];
  const second = await writeRoute(settings, "qwen", replacement, qwenPlan(replacement), first);
  assert.deepEqual(second.edits.map((edit) => edit.path), [["providers", "qwen"]]);
  assert.deepEqual(settings.state.user.providers.qwen.models, replacement);
  await restoreRoute(settings, second);
  assert.deepEqual(settings.state.user, original);
});

test("an existing Qwen provider regains each previous setting when the pull expires", async () => {
  const original = { providers: { qwen: { displayName: "Existing Qwen", api: "openai-completions", baseURL: "https://prior.example.test/v1", models: [{ id: "old" }], custom: "keep" } } };
  const settings = memorySettings(original);
  const route = await writeRoute(settings, "qwen", models, qwenPlan());
  await restoreRoute(settings, route);
  assert.deepEqual(settings.state.user, original);
});

test("cleanup preserves model lists the user edits after pulling", async () => {
  const settings = memorySettings({ providers: { anthropic: { models: [{ id: "original" }], custom: "keep" } } });
  const route = await writeRoute(settings, "anthropic", models);
  settings.state.user.providers.anthropic.models = [{ id: "user-edited" }];
  const edited = structuredClone(settings.state.user);
  await restoreRoute(settings, route);
  assert.deepEqual(settings.state.user, edited);
  assert.equal(settings.calls.length, 1);
});

test("a user edit between two pulls becomes the next pull's restoration target", async () => {
  const settings = memorySettings({ providers: { xai: { models: [{ id: "original" }] } } });
  const first = await writeRoute(settings, "xai", models);
  settings.state.user.providers.xai.models = [{ id: "user-edited" }];
  const edited = structuredClone(settings.state.user);
  const second = await writeRoute(settings, "xai", [{ id: "later-pull" }], undefined, first);
  await restoreRoute(settings, second);
  assert.deepEqual(settings.state.user, edited);
});

test("cleanup preserves later user changes to a plugin-created Qwen provider", async () => {
  const settings = memorySettings({ providers: {} });
  const route = await writeRoute(settings, "qwen", models, qwenPlan());
  settings.state.user.providers.qwen.baseURL = "https://user.example.test/v1";
  settings.state.user.providers.qwen.userOption = "keep";
  const edited = structuredClone(settings.state.user);
  await restoreRoute(settings, route);
  assert.deepEqual(settings.state.user, edited);
  assert.equal(settings.calls.length, 1);
});

test("a pull without prior models removes only the models override during cleanup", async () => {
  const original = { providers: { xai: { custom: "keep" } } };
  const settings = memorySettings(original);
  const route = await writeRoute(settings, "xai", models);
  await restoreRoute(settings, route);
  assert.deepEqual(settings.state.user, original);
});

test("missing settings namespaces reject writes and deferred cleanup instead of claiming success", async () => {
  const settings = memorySettings({}, false);
  await assert.rejects(writeRoute(settings, "xai", models), /设置尚未挂载/);
  await assert.rejects(restoreRoute(settings, { edits: [{ path: ["providers", "xai", "models"], written: models }] }), /设置尚未挂载/);
  assert.equal(settings.calls.length, 0);
});

test("legacy pulls without ownership data do not authorize removing provider configuration", async () => {
  const original = { providers: { xai: { models, custom: "keep" } } };
  const settings = memorySettings(original);
  await restoreRoute(settings, undefined);
  await restoreRoute(settings, { models });
  assert.deepEqual(settings.state.user, original);
  assert.equal(settings.calls.length, 0);
});
