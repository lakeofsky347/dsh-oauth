import assert from "node:assert/strict";
import test from "node:test";
import { loginQwen, qwenEndpoint } from "./qwen.js";

test("qwen endpoint keeps an explicit /v1 resource", () => {
  assert.equal(qwenEndpoint("https://portal.qwen.ai/v1"), "https://portal.qwen.ai/v1");
});

test("qwen endpoint adds https and /v1", () => {
  assert.equal(qwenEndpoint("dashscope.aliyuncs.com/compatible-mode"), "https://dashscope.aliyuncs.com/compatible-mode/v1");
});

test("qwen endpoint falls back when the token has no resource", () => {
  assert.equal(qwenEndpoint(undefined), "https://dashscope.aliyuncs.com/compatible-mode/v1");
});

for (const [label, device, expected] of [
  ["prefers the complete verification URI", { verification_uri_complete: "https://example.invalid/complete", verification_uri: "https://example.invalid/base" }, "https://example.invalid/complete"],
  ["accepts the standard verification URI", { verification_uri: "https://example.invalid/base" }, "https://example.invalid/base"],
  ["falls back from an empty complete verification URI", { verification_uri_complete: "", verification_uri: "https://example.invalid/base" }, "https://example.invalid/base"],
]) {
  test(`Qwen device login ${label}`, async (t) => {
    const controller = new AbortController();
    const notices = [];
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ...device, device_code: "offline-device", user_code: "OFFLINE-CODE", expires_in: 30 })));
    const pending = loginQwen({
      signal: controller.signal,
      notify(notice) { notices.push(notice); controller.abort(new Error("offline test stopped after notice")); },
    });
    await assert.rejects(pending, /offline test stopped after notice/);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].url, expected);
    assert.equal(notices[0].code, "OFFLINE-CODE");
  });
}
