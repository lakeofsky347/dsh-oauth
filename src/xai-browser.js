/** xAI's production loopback Authorization Code + PKCE transport. Never stores credentials. */
import { constants, createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { createServer } from "node:http";

const ISSUER = "https://auth.x.ai";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const ACCOUNTS_ORIGIN = "https://accounts.x.ai";
// Preserve the existing device-flow permission set; the official full CLI also
// requests conversation/workspace scopes that this plugin does not require.
const SCOPES = "openid profile email offline_access grok-cli:access api:access";
const MAX_JSON_BYTES = 1024 * 1024;
const OAUTH_ERRORS = new Set(["invalid_request", "invalid_client", "invalid_grant", "invalid_scope", "access_denied", "unsupported_grant_type", "temporarily_unavailable", "server_error"]);
const ALGORITHMS = {
  RS256: { digest: "sha256", kty: "RSA" }, RS384: { digest: "sha384", kty: "RSA" }, RS512: { digest: "sha512", kty: "RSA" },
  PS256: { digest: "sha256", kty: "RSA", pss: true }, PS384: { digest: "sha384", kty: "RSA", pss: true }, PS512: { digest: "sha512", kty: "RSA", pss: true },
  ES256: { digest: "sha256", kty: "EC", curve: "P-256", signatureBytes: 64 }, ES384: { digest: "sha384", kty: "EC", curve: "P-384", signatureBytes: 96 },
  EdDSA: { digest: null, kty: "OKP" },
};
const failure = (message, code, status) => Object.assign(new Error(message), { code, ...(status === undefined ? {} : { status }) });
const cancelled = () => failure("xAI 浏览器登录已取消", "XAI_BROWSER_CANCELLED");
const equal = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const random = () => randomBytes(32).toString("base64url");
const positive = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw failure("xAI 登录服务返回了无效端点", "XAI_BROWSER_DISCOVERY"); }
  if (url.origin !== ISSUER || url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw failure("xAI 登录服务返回了不受信任的端点", "XAI_BROWSER_DISCOVERY");
  }
  return url.href;
}

function page(response, status, message, origin) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "connection": "close",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...(origin ? { "access-control-allow-origin": origin, "vary": "Origin" } : {}),
  });
  // Every message is a constant owned by this module; request parameters are never reflected.
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>xAI 授权</title><body><h1>xAI 授权</h1><p>${message}</p></body></html>`);
}

async function readJson(response) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new Error("oversized JSON");
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("missing JSON body");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) throw new Error("oversized JSON");
      chunks.push(Buffer.from(value));
    }
  } finally { void reader.cancel().catch(() => {}); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid JSON object");
  return body;
}

/**
 * Test seams change I/O and time only; issuer, public client, scopes and loopback
 * binding remain fixed. Once a valid callback is accepted, the caller's signal
 * cannot interrupt the one-use code exchange; its independent timeout still can.
 * `onExchangeStart` lets the host protect the resulting credential commit too.
 */
export async function loginXaiBrowser(interaction, {
  fetchImpl = globalThis.fetch, timeoutMs = 600000, requestTimeoutMs = 15000,
  discoveryTimeoutMs = 10000, now = Date.now, onExchangeStart, clientVersion,
} = {}) {
  if (typeof interaction?.notify !== "function") throw new TypeError("xAI browser login requires a notify callback");
  if (interaction.signal?.aborted) throw cancelled();
  const waiting = new AbortController();
  const deadlineError = failure("xAI 浏览器登录等待超时，请重新登录", "XAI_BROWSER_TIMEOUT");
  let accepted = false;
  let listener;
  let callbackResolve;
  let callbackReject;
  let callbackSettled = false;
  const callback = new Promise((resolve, reject) => { callbackResolve = resolve; callbackReject = reject; });
  // Discovery can fail before the callback promise is awaited.
  void callback.catch(() => {});
  const rejectWaiting = (error) => {
    if (accepted) return;
    waiting.abort(error);
    if (!callbackSettled) { callbackSettled = true; callbackReject(error); }
  };
  const onAbort = () => rejectWaiting(cancelled());
  interaction.signal?.addEventListener("abort", onAbort, { once: true });
  const lifetime = setTimeout(() => rejectWaiting(deadlineError), positive(timeoutMs, 600000));

  async function requestJson(url, options, label, parentSignal, limit = requestTimeoutMs) {
    const controller = new AbortController();
    const timeout = failure(`xAI ${label}请求超时，请稍后重试`, "XAI_BROWSER_REQUEST_TIMEOUT");
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    const abort = () => rejectAborted(parentSignal?.aborted ? parentSignal.reason : timeout);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(timeout), positive(limit, 15000));
    try {
      if (signal.aborted) abort();
      const operation = Promise.resolve().then(async () => {
        if (signal.aborted) throw signal.reason;
        const response = await fetchImpl(url, { ...options, redirect: "error", signal });
        if (!response.ok) {
          let safeCode;
          try {
            const body = await readJson(response);
            safeCode = [body.error, body.code, body.error?.code].find((code) => OAUTH_ERRORS.has(code));
          } catch { /* Preserve HTTP diagnostics without exposing arbitrary upstream text. */ }
          throw failure(`xAI ${label}失败（HTTP ${response.status}${safeCode ? `，${safeCode}` : ""}），请稍后重试`, "XAI_BROWSER_HTTP", response.status);
        }
        try { return await readJson(response); }
        catch { throw failure(`xAI ${label}返回了无效响应`, "XAI_BROWSER_RESPONSE"); }
      });
      return await Promise.race([operation, aborted]);
    } catch (error) {
      if (parentSignal?.aborted) throw parentSignal.reason;
      if (controller.signal.aborted) throw timeout;
      if (typeof error?.code === "string" && error.code.startsWith("XAI_BROWSER_")) throw error;
      throw failure(`xAI ${label}网络请求失败，请稍后重试`, "XAI_BROWSER_NETWORK");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  try {
    if (interaction.signal?.aborted) onAbort();
    const discovery = await requestJson(`${ISSUER}/.well-known/openid-configuration`, { headers: { accept: "application/json" } }, "登录服务发现", waiting.signal, discoveryTimeoutMs);
    if (discovery.issuer !== undefined && discovery.issuer !== ISSUER) throw failure("xAI 登录服务的 issuer 不匹配", "XAI_BROWSER_DISCOVERY");
    const authorizationEndpoint = endpoint(discovery.authorization_endpoint);
    const tokenEndpoint = endpoint(discovery.token_endpoint);
    const jwksUri = endpoint(discovery.jwks_uri);
    if (Array.isArray(discovery.code_challenge_methods_supported) && !discovery.code_challenge_methods_supported.includes("S256")) {
      throw failure("xAI 登录服务未提供 S256 PKCE", "XAI_BROWSER_DISCOVERY");
    }
    const state = random();
    const nonce = random();
    const verifier = random();
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    let callbackHost;
    listener = createServer((request, response) => {
      try {
        const origin = request.headers.origin;
        if (request.headers.host !== callbackHost || origin !== undefined && origin !== ACCOUNTS_ORIGIN) {
          page(response, 403, "此回调来源不受信任。请返回原授权窗口。", undefined); return;
        }
        if (!request.url || request.url.length > 32768 || !request.url.startsWith("/")) {
          page(response, 400, "授权回调格式无效。", origin); return;
        }
        const url = new URL(request.url, `http://${callbackHost}`);
        if (url.origin !== `http://${callbackHost}` || url.pathname !== "/callback") {
          page(response, 404, "未找到此授权回调。", origin); return;
        }
        if (request.method === "OPTIONS") {
          if (origin !== ACCOUNTS_ORIGIN || request.headers["access-control-request-method"] !== "GET") {
            page(response, 403, "此回调请求不受支持。", undefined); return;
          }
          response.writeHead(204, {
            "access-control-allow-origin": ACCOUNTS_ORIGIN, "access-control-allow-methods": "GET",
            "access-control-allow-private-network": "true", "cache-control": "no-store", "connection": "close",
            "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Private-Network",
          });
          response.end(); return;
        }
        if (request.method !== "GET") { page(response, 405, "此回调仅支持 GET。", origin); return; }
        if (accepted || callbackSettled) { page(response, 409, "此授权回调已处理。请返回管理面板。", origin); return; }
        const params = url.searchParams;
        if (params.getAll("state").length !== 1 || !equal(params.get("state"), state) || params.getAll("code").length > 1 || params.getAll("error").length > 1) {
          page(response, 400, "授权状态不匹配，请返回原授权窗口。", origin); return;
        }
        if (params.has("error")) {
          if (params.has("code")) { page(response, 400, "授权回调格式无效。", origin); return; }
          callbackSettled = true;
          callbackReject(failure("xAI 未批准本次浏览器授权，请重新登录", "XAI_BROWSER_DENIED"));
          page(response, 400, "本次授权未完成。请返回管理面板。", origin); return;
        }
        const code = params.get("code");
        if (typeof code !== "string" || code.length === 0 || code.length > 8192 || /[\x00-\x20\x7f]/.test(code)) {
          page(response, 400, "授权回调缺少有效授权码。", origin); return;
        }
        // Claim before resolving, so simultaneous callbacks cannot exchange twice.
        accepted = true;
        callbackSettled = true;
        clearTimeout(lifetime);
        interaction.signal?.removeEventListener("abort", onAbort);
        callbackResolve(code);
        page(response, 200, "授权回调已收到，正在完成验证。请返回管理面板查看结果。", origin);
      } catch { page(response, 400, "授权回调格式无效。", undefined); }
    });
    listener.maxHeadersCount = 32;
    listener.headersTimeout = 10000;
    listener.requestTimeout = 10000;
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => { listener.removeListener("error", reject); resolve(); });
    });
    listener.on("error", () => rejectWaiting(failure("xAI 本机回调服务失败，请重试", "XAI_BROWSER_LISTENER")));
    const address = listener.address();
    callbackHost = `127.0.0.1:${address.port}`;
    const redirectUri = `http://${callbackHost}/callback`;
    const authorize = new URL(authorizationEndpoint);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, scope: SCOPES, code_challenge: challenge, code_challenge_method: "S256", state, nonce, referrer: "grok-build" })) authorize.searchParams.set(key, value);
    if (waiting.signal.aborted) throw waiting.signal.reason;
    interaction.notify({ url: authorize.href, message: "请在浏览器中完成 xAI 授权，完成后会自动返回本机面板。" });
    const code = await callback;
    (onExchangeStart ?? interaction.onExchangeStart)?.();
    const headers = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
    if (typeof clientVersion === "string" && /^[0-9A-Za-z.+_-]{1,80}$/.test(clientVersion)) headers["x-grok-client-version"] = clientVersion;
    const token = await requestJson(tokenEndpoint, { method: "POST", headers, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: verifier }) }, "授权码交换");
    const tokenString = (value) => typeof value === "string" && value.trim().length > 0 && !/[\r\n\x00]/.test(value);
    if (!tokenString(token.access_token) || !tokenString(token.refresh_token)) {
      throw failure("xAI 授权响应缺少有效访问或刷新令牌", "XAI_BROWSER_TOKEN");
    }
    if (token.token_type !== undefined && (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer")) {
      throw failure("xAI 授权响应的令牌类型不受支持", "XAI_BROWSER_TOKEN");
    }
    const expiresIn = token.expires_in === undefined ? 3600 : token.expires_in;
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) throw failure("xAI 授权响应的有效期无效", "XAI_BROWSER_TOKEN");
    const expires = now() + expiresIn * 1000 - 5 * 60 * 1000;
    if (!Number.isFinite(expires) || !Number.isSafeInteger(Math.trunc(expires))) throw failure("xAI 授权响应的有效期过大", "XAI_BROWSER_TOKEN");
    if (typeof token.id_token !== "string") throw failure("xAI 个人账号授权缺少身份令牌", "XAI_BROWSER_ID_TOKEN");
    await validateIdentityToken(token.id_token, discovery, jwksUri, nonce, requestJson, now);
    return { type: "oauth", access: token.access_token, refresh: token.refresh_token, expires };
  } finally {
    clearTimeout(lifetime);
    interaction.signal?.removeEventListener("abort", onAbort);
    if (listener) await new Promise((resolve) => {
      listener.close(() => resolve());
      listener.closeAllConnections();
    });
  }
}

async function validateIdentityToken(token, discovery, jwksUri, nonce, requestJson, now) {
  try {
    if (token.length > 65536) throw new Error();
    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const header = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    const algorithm = ALGORITHMS[header.alg];
    if (!Object.hasOwn(ALGORITHMS, header.alg) || !algorithm || typeof header.kid !== "string" || !header.kid || header.crit !== undefined) throw new Error();
    if (Array.isArray(discovery.id_token_signing_alg_values_supported) && !discovery.id_token_signing_alg_values_supported.includes(header.alg)) throw new Error();
    const jwks = await requestJson(jwksUri, { headers: { accept: "application/json" } }, "身份签名密钥读取", undefined, 10000);
    const keys = Array.isArray(jwks.keys) ? jwks.keys.filter((key) => key?.kid === header.kid) : [];
    if (keys.length !== 1) throw new Error();
    const jwk = keys[0];
    if (jwk.kty !== algorithm.kty || jwk.alg !== undefined && jwk.alg !== header.alg || jwk.use !== undefined && jwk.use !== "sig" || jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify"))) throw new Error();
    if (algorithm.curve && jwk.crv !== algorithm.curve || header.alg === "EdDSA" && !["Ed25519", "Ed448"].includes(jwk.crv)) throw new Error();
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (algorithm.kty === "RSA" && key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error();
    const signature = Buffer.from(segments[2], "base64url");
    if (algorithm.signatureBytes && signature.length !== algorithm.signatureBytes) throw new Error();
    const keyOptions = algorithm.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : algorithm.kty === "EC" ? { key, dsaEncoding: "ieee-p1363" } : key;
    if (!verify(algorithm.digest, Buffer.from(`${segments[0]}.${segments[1]}`, "ascii"), keyOptions, signature)) throw new Error();
    const audience = claims.aud;
    if (claims.iss !== ISSUER || !(audience === CLIENT_ID || Array.isArray(audience) && audience.includes(CLIENT_ID)) || typeof claims.sub !== "string" || !claims.sub.trim() || !equal(claims.nonce, nonce)) throw new Error();
    const seconds = now() / 1000;
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= seconds - 60 || claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > seconds + 60) || claims.azp !== undefined && claims.azp !== CLIENT_ID) throw new Error();
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("XAI_BROWSER_")) throw error;
    throw failure("xAI 身份令牌验证失败，请重新登录", "XAI_BROWSER_ID_TOKEN");
  }
}
