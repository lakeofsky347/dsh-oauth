import assert from "node:assert/strict";
import test from "node:test";
import { OAuthRequestError, withGrantRecovery } from "./request-errors.js";

test("HTTP authentication rejection refreshes the rejected grant and retries once", async () => {
  const old = { access: "old", refresh: "refresh-old" };
  const renewed = { access: "renewed", refresh: "refresh-new" };
  const resolutions = [];
  const operations = [];
  const result = await withGrantRecovery("anthropic", async (provider, options) => {
    resolutions.push({ provider, options });
    return options ? renewed : old;
  }, async (grant) => {
    operations.push(grant);
    if (grant === old) throw new OAuthRequestError("anthropic", 401, JSON.stringify({ error: { type: "authentication_error", message: "denied" } }));
    return "models-returned";
  });
  assert.equal(result, "models-returned");
  assert.deepEqual(resolutions, [{ provider: "anthropic", options: undefined }, { provider: "anthropic", options: { rejectedGrant: old } }]);
  assert.deepEqual(operations, [old, renewed]);
});

test("xAI's precise bad-credentials responses allow one recovery despite HTTP 403", async () => {
  const bodies = [
    { code: "unauthenticated:bad-credentials", error: "The OAuth2 access token could not be validated." },
    { error: { code: "bad-credentials" } },
    { body: { error: { code: "unauthenticated:bad-credentials" } } },
    { error: { message: "The OAuth2 access token could not be validated." } },
  ];
  for (const body of bodies) {
    let resolveCalls = 0;
    let operationCalls = 0;
    const result = await withGrantRecovery("xai", async () => ({ access: `grant-${++resolveCalls}` }), async () => {
      if (++operationCalls === 1) throw new OAuthRequestError("xai", 403, JSON.stringify(body));
      return "success";
    });
    assert.equal(result, "success");
    assert.equal(resolveCalls, 2);
    assert.equal(operationCalls, 2);
  }
});

test("a second authentication rejection is returned without a third request or another refresh", async () => {
  const first = new OAuthRequestError("xai", 401, "unauthorized");
  const second = new OAuthRequestError("xai", 403, JSON.stringify({ code: "unauthenticated:bad-credentials" }));
  let resolveCalls = 0;
  let operationCalls = 0;
  await assert.rejects(withGrantRecovery("xai", async () => ({ access: `grant-${++resolveCalls}` }), async () => {
    throw ++operationCalls === 1 ? first : second;
  }), (error) => error === second);
  assert.equal(resolveCalls, 2);
  assert.equal(operationCalls, 2);
});

test("permission, billing, rate, network, and unrelated provider failures never refresh or repeat the request", async () => {
  const failures = [
    new OAuthRequestError("xai", 403, JSON.stringify({ code: "permission_denied" })),
    new OAuthRequestError("xai", 403, JSON.stringify({ error: { code: "insufficient_scope" } })),
    new OAuthRequestError("xai", 403, "<html>Cloudflare challenge</html>"),
    new OAuthRequestError("xai", 403, JSON.stringify({ message: "Try refreshing; error code unknown" })),
    new OAuthRequestError("xai", 402, JSON.stringify({ code: "bad-credentials" })),
    new OAuthRequestError("xai", 429, JSON.stringify({ code: "bad-credentials" })),
    new OAuthRequestError("xai", 503, JSON.stringify({ code: "bad-credentials" })),
    new OAuthRequestError("anthropic", 403, JSON.stringify({ code: "bad-credentials" })),
    new OAuthRequestError("anthropic", 401, "unauthorized"),
    new Error("network failure mentions 401"),
    Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
    Object.assign(new Error("user cancelled"), { name: "AbortError" }),
  ];
  for (const failure of failures) {
    let resolveCalls = 0;
    let operationCalls = 0;
    await assert.rejects(withGrantRecovery("xai", async () => { resolveCalls += 1; return { access: "old" }; }, async () => {
      operationCalls += 1;
      throw failure;
    }), (error) => error === failure);
    assert.equal(resolveCalls, 1);
    assert.equal(operationCalls, 1);
  }
});

test("refresh failure preserves its cause and original request failure without making a second request", async () => {
  const rejection = new OAuthRequestError("xai", 401, "unauthorized");
  const refreshError = new Error("temporary refresh transport failure");
  let resolveCalls = 0;
  let operationCalls = 0;
  await assert.rejects(withGrantRecovery("xai", async () => {
    if (++resolveCalls === 2) throw refreshError;
    return { access: "old" };
  }, async () => { operationCalls += 1; throw rejection; }), (error) => {
    assert.equal(error.name, "OAuthRecoveryError");
    assert.equal(error.cause, refreshError);
    assert.equal(error.requestError, rejection);
    assert.doesNotMatch(error.message, /重新登录|重登|登录已过期/);
    return true;
  });
  assert.equal(resolveCalls, 2);
  assert.equal(operationCalls, 1);
});

test("initial grant resolution errors propagate without attempting the operation or forced refresh", async () => {
  const failure = new Error("credential store is unavailable");
  let resolveCalls = 0;
  let operationCalls = 0;
  await assert.rejects(withGrantRecovery("xai", async () => { resolveCalls += 1; throw failure; }, async () => { operationCalls += 1; }), (error) => error === failure);
  assert.equal(resolveCalls, 1);
  assert.equal(operationCalls, 0);
});

test("request diagnostics do not retain arbitrary response text, token-like error codes, or token values", () => {
  const token = "sensitive-access-token-must-not-appear";
  for (const status of [401, 403, 429, 500]) {
    const error = new OAuthRequestError("xai", status, JSON.stringify({
      code: token, error: { code: "unauthenticated:bad-credentials", message: `Bearer ${token}` }, access_token: token,
    }));
    assert.doesNotMatch(String(error), new RegExp(token));
    assert.doesNotMatch(JSON.stringify(error), new RegExp(token));
    assert.equal(error.code, "unauthenticated:bad-credentials");
    assert.equal(Object.hasOwn(error, "body"), false);
    assert.equal(Object.hasOwn(error, "text"), false);
  }
});

test("an arbitrary sentence or error code containing bad-credentials does not authorize a refresh", () => {
  for (const body of [
    { code: "permission_denied:bad-credentials" },
    { message: "This permission error is unrelated to access token could not be validated" },
    { error: "bad-credentials was mentioned by a user" },
  ]) assert.equal(new OAuthRequestError("xai", 403, JSON.stringify(body)).authenticationRejected, false);
  assert.equal(new OAuthRequestError("xai", 403, "access_token could not be validated").authenticationRejected, true);
});
