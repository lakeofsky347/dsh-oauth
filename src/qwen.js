/**
 * Official Qwen account login (chat.qwen.ai device flow).
 * The access token is what the coding endpoint accepts as a bearer.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

const CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const SCOPE = "openid profile email model.completion";
const DEVICE_URL = "https://chat.qwen.ai/api/v1/oauth2/device/code";
const TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token";
const DEFAULT_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/**
 * OpenAI-compatible base URL for a Qwen OAuth resource.
 * @param {unknown} resourceUrl
 */
export function qwenEndpoint(resourceUrl) {
  const raw = typeof resourceUrl === "string" && resourceUrl.trim().length > 0 ? resourceUrl.trim() : DEFAULT_BASE;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const trimmed = withProtocol.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * @param {{ notify: (notice: { message?: string, url?: string }) => void, signal: AbortSignal }} session
 */
export async function loginQwen(session) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const device = await postForm(DEVICE_URL, {
    client_id: CLIENT_ID,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }, session.signal);
  const url = firstString(device.verification_uri_complete, device.verification_uri);
  if (url === undefined || typeof device.device_code !== "string") {
    throw new Error("通义千问没有返回登录地址");
  }
  session.notify({ message: "在浏览器里完成通义千问登录", url, ...(device.user_code ? { code: device.user_code } : {}) });
  const expiresIn = Number(device.expires_in);
  const deadline = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000;
  let waitMs = 2000;
  while (Date.now() < deadline) {
    session.signal.throwIfAborted();
    await delay(waitMs, session.signal);
    const token = await postForm(TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      device_code: device.device_code,
      code_verifier: verifier,
    }, session.signal);
    if (token.pending === true) {
      if (token.slowDown === true) waitMs += 2000;
      continue;
    }
    const access = firstString(token.access_token);
    if (access === undefined) throw new Error("通义千问登录没有返回 access token");
    const lifetime = Number(token.expires_in);
    return {
      access,
      refresh: firstString(token.refresh_token),
      expires: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000,
      resourceUrl: qwenEndpoint(token.resource_url),
    };
  }
  throw new Error("通义千问登录超时");
}

/** Refresh the OAuth grant without losing a non-rotated refresh token or resource URL. */
export async function refreshQwen(grant, signal = AbortSignal.timeout(20000)) {
  if (typeof grant.refresh !== "string" || grant.refresh.length === 0) {
    throw new Error("通义千问登录已过期，请重新登录");
  }
  const token = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: grant.refresh,
  }, signal);
  const access = firstString(token.access_token);
  if (access === undefined) throw new Error("通义千问刷新没有返回 access token，请重新登录");
  const lifetime = Number(token.expires_in);
  return {
    ...grant,
    access,
    refresh: firstString(token.refresh_token) ?? grant.refresh,
    expires: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000,
    resourceUrl: qwenEndpoint(firstString(token.resource_url) ?? grant.resourceUrl),
  };
}

async function postForm(url, fields, signal) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") body.set(key, value);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "x-request-id": randomUUID(),
    },
    body,
    signal,
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  const error = typeof payload.error === "string" ? payload.error : "";
  if (response.status === 400 && error === "authorization_pending") return { pending: true };
  if ((response.status === 429 || response.status === 400) && error === "slow_down") return { pending: true, slowDown: true };
  if (!response.ok) {
    throw new Error(`通义千问登录返回 ${response.status}${error ? `: ${error}` : ""}`);
  }
  return payload;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("登录已取消"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}
