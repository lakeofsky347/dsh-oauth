import assert from "node:assert/strict";
import test from "node:test";
import { qwenEndpoint } from "./qwen.js";

test("qwen endpoint keeps an explicit /v1 resource", () => {
  assert.equal(qwenEndpoint("https://portal.qwen.ai/v1"), "https://portal.qwen.ai/v1");
});

test("qwen endpoint adds https and /v1", () => {
  assert.equal(qwenEndpoint("dashscope.aliyuncs.com/compatible-mode"), "https://dashscope.aliyuncs.com/compatible-mode/v1");
});

test("qwen endpoint falls back when the token has no resource", () => {
  assert.equal(qwenEndpoint(undefined), "https://dashscope.aliyuncs.com/compatible-mode/v1");
});
