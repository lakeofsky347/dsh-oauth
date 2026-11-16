/** Provider quota units and dates are explicit: unknown never means zero. */
export const finite = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : undefined;
};
export function iso(value, unit = 'iso') {
  const time = unit === 'iso' ? (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN)
    : finite(value) === undefined ? NaN : finite(value) * (unit === 'seconds' ? 1000 : 1);
  return Number.isFinite(time) && time >= 0 && time <= 8.64e15 ? new Date(time).toISOString() : undefined;
}
const compact = row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
export function quotaWindow(row) {
  const out = { ...row };
  for (const key of ['used', 'limit', 'remaining', 'usedPercent', 'remainingPercent', 'nextRegenPercent']) out[key] = finite(out[key]);
  if (out.limit !== undefined && out.used !== undefined && out.remaining === undefined) out.remaining = out.limit - out.used;
  if (out.limit !== undefined && out.remaining !== undefined && out.used === undefined) out.used = out.limit - out.remaining;
  if (out.usedPercent === undefined && out.remainingPercent !== undefined) out.usedPercent = 100 - out.remainingPercent;
  if (out.usedPercent === undefined && out.limit > 0 && out.used !== undefined) out.usedPercent = 100 * out.used / out.limit;
  if (out.remainingPercent === undefined && out.usedPercent !== undefined) out.remainingPercent = 100 - out.usedPercent;
  return compact(out);
}
export function balance(row) {
  if (finite(row.amount) === undefined) throw new UsageError('invalid-response', 'Invalid balance amount.');
  return compact({ ...row });
}
export class UsageError extends Error {
  constructor(code, message, { status, retryAt } = {}) {
    super(message);
    this.name = 'UsageError'; this.code = code; this.status = status; this.retryAt = retryAt;
  }
}

/** No redirects, no response body in errors, bounded size and timeout. */
export function createUsageRequest({ allowedHosts, fetchImpl = fetch, now = () => Date.now() }) {
  const hosts = new Set(allowedHosts);
  return async (url, options = {}) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || !hosts.has(target.hostname) || target.port && target.port !== '443') {
      throw new UsageError('needs-configuration', 'The usage endpoint is not an approved provider host.');
    }
    const headers = new Headers(options.headers);
    let body = options.body;
    if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
      body = JSON.stringify(body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    let response;
    try {
      response = await fetchImpl(target.toString(), { ...options, body, headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw new UsageError('unavailable', 'The usage service is temporarily unreachable.'); }
    if (!response.ok) {
      const code = response.status === 401 ? 'reauth-required' : response.status === 403 ? 'needs-permission' : response.status === 429 ? 'rate-limited' : 'unavailable';
      const retry = response.headers.get('retry-after');
      const retryTime = retry && /^\d+$/.test(retry) ? now() + Number(retry) * 1000 : retry ? Date.parse(retry) : NaN;
      await response.body?.cancel();
      throw new UsageError(code, `Usage query returned HTTP ${response.status}.`, { status: response.status, retryAt: Number.isFinite(retryTime) ? new Date(retryTime).toISOString() : undefined });
    }
    let size = 0; const chunks = [];
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new UsageError('invalid-response', 'Usage response exceeds the size limit.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new UsageError('invalid-response', 'The usage service did not return valid JSON.'); }
  };
}
