import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { request } from "node:http";
import { loginXaiBrowser } from "./xai-browser.js";

const ISSUER = "https://auth.x.ai";
const CLIENT = "b1a00492-073a-47ea-816f-4c329264a828";
const NOW = 1800000000000;
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "ES256", use: "sig" };
const discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth2/authorize`, token_endpoint: `${ISSUER}/oauth2/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json`, code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["ES256"] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function jwt(nonce, claimChanges = {}, headerChanges = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "test-key", ...headerChanges })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: CLIENT, sub: "mock-user", exp: NOW / 1000 + 3600, nonce, ...claimChanges })).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}
function http(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
function flow({ metadata = {}, tokenChanges = {}, claims = {}, jwtHeader = {}, jwks, tokenImpl, idTokenImpl, onExchangeStart, options = {} } = {}) {
  const ready = defer();
  const tokenStarted = defer();
  const controller = new AbortController();
  const calls = [];
  let authUrl;
  let exchangeMarked = false;
  const promise = loginXaiBrowser({
    signal: controller.signal,
    notify(notice) { authUrl = new URL(notice.url); ready.resolve(authUrl); },
    onExchangeStart() { exchangeMarked = true; onExchangeStart?.(controller); },
  }, {
    now: () => NOW,
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === `${ISSUER}/.well-known/openid-configuration`) return json({ ...discovery, ...metadata });
      if (String(url) === `${ISSUER}/oauth2/token`) {
        assert.equal(exchangeMarked, true, "the host learns the exchange phase before its POST starts");
        tokenStarted.resolve();
        if (tokenImpl) return tokenImpl(url, init, authUrl);
        const nonce = authUrl.searchParams.get("nonce");
        return json({ access_token: "mock-browser-access", refresh_token: "mock-browser-refresh", expires_in: 3600, id_token: idTokenImpl ? idTokenImpl(nonce) : jwt(nonce, claims, jwtHeader), ...tokenChanges });
      }
      if (String(url) === `${ISSUER}/.well-known/jwks.json`) return json(jwks ?? { keys: [publicJwk] });
      throw new Error("unexpected external request refused by test");
    },
  });
  // Some tests deliberately reject before they await the flow.
  void promise.catch(() => {});
  return {
    promise, controller, calls, tokenStarted: tokenStarted.promise,
    async url() { return ready.promise; },
    async callback(query = {}, headers) {
      const authorize = await ready.promise;
      const url = new URL(authorize.searchParams.get("redirect_uri"));
      url.search = new URLSearchParams({ state: authorize.searchParams.get("state"), code: "mock-authorization-code", ...query });
      return http(url, { headers });
    },
  };
}
const closed = async (authorize) => assert.rejects(http(new URL(authorize.searchParams.get("redirect_uri"))), (error) => error.code === "ECONNREFUSED");

test("token endpoint failures expose only a standard OAuth code and never its arbitrary description", async () => {
  const pending = flow({ tokenImpl: () => json({ error: "invalid_scope", error_description: "private-response-must-not-appear" }, 400) });
  await pending.callback();
  await assert.rejects(pending.promise, (error) => {
    assert.match(error.message, /HTTP 400，invalid_scope/);
    assert.doesNotMatch(error.message, /private-response-must-not-appear/);
    return true;
  });
});

test("actual loopback callback completes S256 exchange and verifies the signed OIDC identity", async () => {
  const pending = flow();
  const authorize = await pending.url();
  const redirect = new URL(authorize.searchParams.get("redirect_uri"));
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.equal(redirect.pathname, "/callback");
  assert.ok(Number(redirect.port) > 0);
  assert.equal(authorize.origin, ISSUER);
  assert.equal(authorize.pathname, "/oauth2/authorize");
  assert.equal(authorize.searchParams.get("client_id"), CLIENT);
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("scope"), "openid profile email offline_access grok-cli:access api:access");
  assert.equal(authorize.searchParams.get("referrer"), "grok-build");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorize.searchParams.get("state"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorize.searchParams.get("nonce"), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(authorize.searchParams.get("state"), authorize.searchParams.get("nonce"));
  const response = await pending.callback({}, { origin: "https://accounts.x.ai" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], "https://accounts.x.ai");
  assert.ok(!response.body.includes("mock-authorization-code"));
  const grant = await pending.promise;
  assert.deepEqual(grant, { type: "oauth", access: "mock-browser-access", refresh: "mock-browser-refresh", expires: NOW + 3300000 });
  const exchange = pending.calls.find((call) => call.url.endsWith("/token"));
  const form = exchange.init.body;
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("client_id"), CLIENT);
  assert.equal(form.get("redirect_uri"), redirect.href);
  assert.equal(form.get("code"), "mock-authorization-code");
  assert.match(form.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash("sha256").update(form.get("code_verifier"), "ascii").digest("base64url"), authorize.searchParams.get("code_challenge"));
  assert.equal(form.has("client_secret"), false);
  assert.equal(exchange.init.headers["x-grok-client-version"], undefined);
  await closed(authorize);
});

test("Host/Origin/state validation and CORS/PNA preflight do not consume the valid attempt", async () => {
  const pending = flow();
  const authorize = await pending.url();
  const redirect = authorize.searchParams.get("redirect_uri");
  assert.equal((await pending.callback({}, { host: "evil.example" })).status, 403);
  assert.equal((await pending.callback({}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await pending.callback({}, { origin: "null" })).status, 403);
  assert.equal((await pending.callback({ state: "wrong-state" })).status, 400);
  assert.equal((await pending.callback({ state: "wrong-state", error: "access_denied" })).status, 400);
  const repeated = new URL(redirect);
  repeated.search = new URLSearchParams({ state: authorize.searchParams.get("state"), code: "test" });
  repeated.searchParams.append("state", authorize.searchParams.get("state"));
  assert.equal((await http(repeated)).status, 400);
  assert.equal(pending.calls.length, 1, "only discovery was requested after malicious callbacks");
  const preflight = await http(redirect, { method: "OPTIONS", headers: { origin: "https://accounts.x.ai", "access-control-request-method": "GET", "access-control-request-private-network": "true" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://accounts.x.ai");
  assert.equal(preflight.headers["access-control-allow-private-network"], "true");
  assert.equal((await http(redirect, { method: "OPTIONS", headers: { origin: "https://accounts.x.ai", "access-control-request-method": "POST" } })).status, 403);
  assert.equal((await http(redirect, { method: "POST" })).status, 405);
  assert.equal((await http(new URL("/other", redirect))).status, 404);
  assert.equal((await pending.callback()).status, 200);
  assert.equal((await pending.promise).type, "oauth");
});

test("simultaneous callback replay is rejected while the single token exchange is pending", async () => {
  const gate = defer();
  const pending = flow({ tokenImpl: async (_url, _init, authorize) => {
    await gate.promise;
    return json({ access_token: "mock-a", refresh_token: "mock-r", id_token: jwt(authorize.searchParams.get("nonce")) });
  } });
  assert.equal((await pending.callback()).status, 200);
  await pending.tokenStarted;
  assert.equal((await pending.callback()).status, 409);
  assert.equal(pending.calls.filter((call) => call.url.endsWith("/token")).length, 1);
  gate.resolve();
  assert.equal((await pending.promise).access, "mock-a");
});

test("a valid-state provider denial is terminal and does not echo error descriptions", async () => {
  const pending = flow();
  const authorize = await pending.url();
  const redirect = new URL(authorize.searchParams.get("redirect_uri"));
  redirect.search = new URLSearchParams({ state: authorize.searchParams.get("state"), error: "access_denied", error_description: "sensitive-callback-detail" });
  const response = await http(redirect);
  assert.equal(response.status, 400);
  assert.ok(!response.body.includes("sensitive-callback-detail"));
  await assert.rejects(pending.promise, (error) => error.code === "XAI_BROWSER_DENIED" && !error.message.includes("sensitive-callback-detail"));
  assert.equal(pending.calls.length, 1);
  await closed(authorize);
});

test("cancellation and waiting timeout close the real callback listener", async (t) => {
  await t.test("pre-aborted signal never fetches", async () => {
    const controller = new AbortController(); controller.abort();
    let fetched = false;
    await assert.rejects(loginXaiBrowser({ signal: controller.signal, notify() {} }, { fetchImpl: async () => { fetched = true; } }), (error) => error.code === "XAI_BROWSER_CANCELLED");
    assert.equal(fetched, false);
  });
  await t.test("cancel while waiting", async () => {
    const pending = flow(); const authorize = await pending.url();
    pending.controller.abort(new Error("must-not-be-reflected"));
    await assert.rejects(pending.promise, (error) => error.code === "XAI_BROWSER_CANCELLED" && !error.message.includes("must-not-be-reflected"));
    await closed(authorize);
  });
  await t.test("wait expires", async () => {
    const pending = flow({ options: { timeoutMs: 60 } }); const authorize = await pending.url();
    await assert.rejects(pending.promise, (error) => error.code === "XAI_BROWSER_TIMEOUT");
    await closed(authorize);
  });
});

test("ordinary cancellation after exchange starts does not discard the one-use code exchange", async () => {
  const pending = flow({ onExchangeStart: (controller) => controller.abort() });
  assert.equal((await pending.callback()).status, 200);
  assert.equal((await pending.promise).type, "oauth");
  assert.equal(pending.controller.signal.aborted, true);
});

test("a stalled token request is bounded independently and closes the listener", async () => {
  const pending = flow({ options: { requestTimeoutMs: 30 }, tokenImpl: () => new Promise(() => {}) });
  const authorize = await pending.url();
  await pending.callback();
  await assert.rejects(pending.promise, (error) => error.code === "XAI_BROWSER_REQUEST_TIMEOUT");
  await closed(authorize);
});

test("token exchange failures are sanitized and incomplete credentials never report success", async (t) => {
  for (const [name, change] of [["missing access", { access_token: "" }], ["missing refresh", { refresh_token: undefined }], ["invalid expiry", { expires_in: -1 }], ["overflowing expiry", { expires_in: 1e308 }], ["non-Bearer token", { token_type: "mac" }], ["blank access", { access_token: "   " }], ["missing personal ID token", { id_token: undefined }]]) {
    await t.test(name, async () => {
      const pending = flow({ tokenChanges: change }); await pending.callback();
      await assert.rejects(pending.promise, (error) => /XAI_BROWSER_(TOKEN|ID_TOKEN)/.test(error.code) && !error.message.includes("mock-browser"));
    });
  }
  for (const [name, implementation] of [["network", () => { throw new Error("sensitive-mock-token-detail"); }], ["HTTP error", () => json({ error_description: "sensitive-mock-token-detail" }, 400)], ["invalid JSON", () => new Response("sensitive-mock-token-detail")]]) {
    await t.test(name, async () => {
      const pending = flow({ tokenImpl: implementation }); await pending.callback();
      await assert.rejects(pending.promise, (error) => error.code.startsWith("XAI_BROWSER_") && !error.message.includes("sensitive-mock-token-detail"));
    });
  }
});

test("ID token signature, nonce, issuer, audience, expiry, subject and key identity are enforced", async (t) => {
  const cases = [
    ["nonce", { claims: { nonce: "wrong" } }], ["issuer", { claims: { iss: "https://evil.example" } }],
    ["audience", { claims: { aud: "other-client" } }], ["expiry", { claims: { exp: NOW / 1000 - 120 } }],
    ["subject", { claims: { sub: "" } }], ["blank subject", { claims: { sub: "   " } }], ["kid", { jwtHeader: { kid: "unknown" } }],
    ["symmetric/none algorithm", { jwtHeader: { alg: "HS256" } }],
    ["invalid signature", { idTokenImpl: (nonce) => { const token = jwt(nonce).split("."); token[2] = Buffer.alloc(64, 1).toString("base64url"); return token.join("."); } }],
    ["duplicate key IDs", { jwks: { keys: [publicJwk, publicJwk] } }],
  ];
  for (const [name, options] of cases) await t.test(name, async () => {
    const pending = flow(options); await pending.callback();
    await assert.rejects(pending.promise, (error) => error.code === "XAI_BROWSER_ID_TOKEN");
  });
});

test("untrusted discovery endpoints and unsupported PKCE are rejected before notification", async (t) => {
  for (const metadata of [{ token_endpoint: "https://evil.example/token" }, { authorization_endpoint: "http://auth.x.ai/authorize" }, { jwks_uri: "https://evil.example/jwks" }, { issuer: "https://evil.example" }, { code_challenge_methods_supported: ["plain"] }]) {
    await t.test(JSON.stringify(metadata), async () => {
      const pending = flow({ metadata });
      await assert.rejects(pending.promise, (error) => error.code === "XAI_BROWSER_DISCOVERY");
      assert.equal(pending.calls.length, 1);
    });
  }
});


test("discovery has its own deadline and never opens a listener when it stalls", async () => {
  let notified = false;
  await assert.rejects(loginXaiBrowser({ notify() { notified = true; } }, {
    discoveryTimeoutMs: 30,
    fetchImpl: () => new Promise(() => {}),
  }), (error) => error.code === "XAI_BROWSER_REQUEST_TIMEOUT");
  assert.equal(notified, false);
});
