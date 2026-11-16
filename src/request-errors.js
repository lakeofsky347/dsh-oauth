const BAD_CREDENTIALS_CODES = new Set(["bad-credentials", "unauthenticated:bad-credentials"]);
const SAFE_ERROR_CODES = new Set([
  ...BAD_CREDENTIALS_CODES,
  "invalid_token", "invalid_grant", "invalid_api_key", "unauthorized", "authentication_error",
  "access_denied", "insufficient_scope", "permission_denied", "forbidden",
  "rate_limit_exceeded", "too_many_requests", "subscription:free-usage-exhausted", "free-usage-exhausted",
]);

const providerLabel = (provider) => typeof provider === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(provider) ? provider : "OAuth";
const normalized = (value) => typeof value === "string" ? value.trim().toLowerCase() : undefined;
const tokenValidationFailure = (value) => typeof value === "string" &&
  /^(?:the\s+)?(?:oauth2\s+)?access[ _]token could not be validated[.!]?$/i.test(value.trim());

/** Keep response diagnostics useful without retaining arbitrary upstream text or credentials. */
export class OAuthRequestError extends Error {
  constructor(provider, status, text) {
    let body;
    try { body = JSON.parse(typeof text === "string" ? text : ""); }
    catch { /* Only an exact plain-text token-validation failure is recognized below. */ }
    const codes = [body?.code, body?.error?.code, body?.body?.error?.code, body?.error].map(normalized);
    const code = codes.find((value) => SAFE_ERROR_CODES.has(value));
    const messages = [body?.message, body?.error?.message, body?.error, body?.body?.error?.message,
      body?.body?.error, typeof body === "string" ? body : undefined, typeof body === "undefined" ? text : undefined];
    const badCredentials = codes.some((value) => BAD_CREDENTIALS_CODES.has(value)) || messages.some(tokenValidationFailure);
    super(`${providerLabel(provider)} 请求返回 HTTP ${status}${code ? `（${code}）` : ""}`);
    this.name = "OAuthRequestError";
    this.provider = provider;
    this.status = status;
    if (code) this.code = code;
    this.authenticationRejected = status === 401 || provider === "xai" && status === 403 && badCredentials;
  }
}

/** Retry an operation once after an explicit rejection of the grant it used. */
export async function withGrantRecovery(provider, resolveGrant, operation) {
  const grant = await resolveGrant(provider);
  try { return await operation(grant); }
  catch (error) {
    if (!(error instanceof OAuthRequestError) || error.provider !== provider || !error.authenticationRejected) throw error;
    let renewed;
    try { renewed = await resolveGrant(provider, { rejectedGrant: grant }); }
    catch (refreshError) {
      const failure = new Error(`${providerLabel(provider)} 请求被拒绝后自动续期失败（HTTP ${error.status}）`, { cause: refreshError });
      failure.name = "OAuthRecoveryError";
      failure.requestError = error;
      throw failure;
    }
    return operation(renewed);
  }
}
