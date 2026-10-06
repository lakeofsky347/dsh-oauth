/**
 * DeepSeek official-account calls for Harness 0.2.
 * startSignIn and signOut take AccountClientMetadata, and the callback
 * origin must be a loopback http URL with an explicit port.
 */

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i;
const FALLBACK_VERSION = "0.2.0-rc.2";
const TERMINAL_FAILURE = new Set(["failed", "expired", "cancelled"]);

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * @param {unknown} header
 * @returns {string | undefined}
 */
export function localeFromAcceptLanguage(header) {
  if (typeof header !== "string") return undefined;
  return nonEmpty(header.split(",")[0]?.split(";")[0]);
}

/**
 * Identity the 0.2 account service puts on Platform request headers.
 * @param {{ version?: string, locale?: string, timezoneOffsetSeconds?: number }} [input]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function accountClientMetadata(input = {}, env = process.env) {
  const offset = input.timezoneOffsetSeconds;
  return {
    version: nonEmpty(input.version) ?? nonEmpty(env.DSH_CLIENT_VERSION) ?? FALLBACK_VERSION,
    locale: nonEmpty(input.locale) ?? "zh-CN",
    timezoneOffsetSeconds: Number.isInteger(offset) ? offset : -new Date().getTimezoneOffset() * 60,
  };
}

/**
 * @param {import("node:http").IncomingMessage | { headers?: Record<string, unknown> } | undefined} req
 * @param {NodeJS.ProcessEnv} [env]
 */
export function accountClientFrom(req, env = process.env) {
  const header = req?.headers?.["accept-language"];
  return accountClientMetadata({ locale: localeFromAcceptLanguage(header) }, env);
}

/**
 * Origin accepted by the account service's loginOrigin check.
 * @param {unknown} host
 * @returns {string}
 */
export function loginCallbackOrigin(host) {
  const raw = nonEmpty(host) ?? "127.0.0.1:19387";
  let url;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    throw new Error("登录回调地址必须是本机 http 端口");
  }
  const bare = url.hostname;
  const hostname = bare.startsWith("[") ? bare : bare.includes(":") ? `[${bare}]` : bare;
  if (!LOOPBACK.test(hostname) || url.port.length === 0 || Number(url.port) === 0 || url.username || url.password) {
    throw new Error("登录回调地址必须是本机 http 端口");
  }
  return `http://${hostname}:${Number(url.port)}`;
}

/**
 * Desktop listens on 19387. Any other loopback port is the web profile.
 * @param {string} origin
 */
export function loginSource(origin) {
  return origin.endsWith(":19387") ? "desktop" : "web";
}

/**
 * @param {unknown} phase
 */
export function signInFailed(phase) {
  return typeof phase === "string" && TERMINAL_FAILURE.has(phase);
}
