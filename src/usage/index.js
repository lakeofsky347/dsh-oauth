import { createProfileStore } from '../profile-store.js';
import { accountFingerprint } from '../connections.js';
import { createUsageRequest, UsageError, balance, quotaWindow, finite } from './core.js';
import { fetchOfficialUsage, officialUsageIds } from './official.js';
import { fetchAggregatorUsage, aggregatorUsageIds } from './aggregators.js';

export const usageIds = new Set([...officialUsageIds, ...aggregatorUsageIds, 'deepseek', 'new-api']);
const hosts = [
  'chatgpt.com', 'api.anthropic.com', 'api.github.com', 'api.kimi.com', 'api.kimi.ai',
  'api.minimax.cn', 'api.minimax.io', 'bigmodel.cn', 'api.z.ai', 'bailian-cs.console.aliyun.com',
  'bailian-singapore-cs.alibabacloud.com', 'daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com',
  'cli-chat-proxy.grok.com', 'portal.nousresearch.com', 'openrouter.ai', 'api.nano-gpt.com',
  'nano-gpt.com', 'zenmux.ai', 'opencode.ai', 'app.kilo.ai', 'api.poe.com',
  'api.synthetic.new', 'api.chutes.ai', 'api.deepseek.com',
];
export async function fetchUsage(id, context) {
  if (officialUsageIds.includes(id)) return fetchOfficialUsage(id, context);
  if (aggregatorUsageIds.includes(id)) return fetchAggregatorUsage(id, context);
  const headers = { Authorization: `Bearer ${context.access}`, Accept: 'application/json' };
  if (id === 'deepseek') {
    const data = await context.request('https://api.deepseek.com/user/balance', { headers });
    if (!Array.isArray(data.balance_infos) || !data.balance_infos.length) throw new UsageError('invalid-response', 'No recognized account balance.');
    const balances = data.balance_infos.filter(row => finite(row.total_balance) !== undefined).map((row, i) => balance({ id: `balance-${i}`, label: 'API account balance', unit: 'money', currency: row.currency, amount: row.total_balance, scope: 'account:api' }));
    if (!balances.length) throw new UsageError('invalid-response', 'No recognized account balance.');
    return { windows: [], balances };
  }
  if (id === 'new-api') {
    if (!context.baseURL) throw new UsageError('needs-configuration', 'Configure the New API deployment URL.');
    const url = new URL(context.baseURL);
    const body = await context.request(`${url.origin}/api/usage/token/`, { headers });
    const data = body?.data;
    if (body.success === false || !data || finite(data.total_available) === undefined && finite(data.total_used) === undefined) throw new UsageError('invalid-response', 'This deployment does not expose the expected token quota contract.');
    return { windows: [quotaWindow({ id: 'token-budget', label: 'Deployment token budget', unit: 'quota', scope: 'api-key', remaining: finite(data.total_available), used: finite(data.total_used), limit: finite(data.total_granted), unlimited: data.unlimited_quota === true })], balances: [], notes: ['deployment-quota-units-are-not-currency'] };
  }
  throw new UsageError('unsupported', 'This provider has no verified remote usage reader.');
}

/** Cached snapshots remain observations, never estimates of a provider balance. */
export function createUsageService({ directory, contextFor, fetchImpl, now = () => Date.now(), reader = fetchUsage }) {
  const store = createProfileStore(directory, 'dsh-oauth-usage.json');
  const inflight = new Map();
  const generations = new Map();
  const query = async (id, force) => {
    if (!usageIds.has(id)) return { status: 'unsupported', lastAttemptAt: new Date(now()).toISOString() };
    const generation = generations.get(id) ?? 0;
    let context;
    try { context = await contextFor(id); }
    catch { return { status: 'reauth-required', lastAttemptAt: new Date(now()).toISOString(), message: 'Reconnect or renew the source CLI authorization.' }; }
    const fingerprint = accountFingerprint(context.connection, context.rawGrant ?? { access: context.access });
    const cached = await store.read(id);
    const previous = cached?.fingerprint === fingerprint ? cached.result : undefined;
    const age = now() - Date.parse(previous?.lastAttemptAt ?? '');
    if (previous && (age < (force ? 5000 : 60000) || Date.parse(previous.retryAt) > now())) return previous;
    const lastAttemptAt = new Date(now()).toISOString();
    let result;
    try {
      const allowedHosts = id === 'new-api' && context.baseURL ? [new URL(context.baseURL).hostname] : hosts;
      const data = await reader(id, { ...context, now: now(), request: createUsageRequest({ allowedHosts, fetchImpl, now }) });
      const { status, ...snapshot } = data;
      result = { status: status ?? 'fresh', snapshot: { ...snapshot, observedAt: lastAttemptAt, source: 'provider-api' }, lastAttemptAt };
    } catch (error) {
      let status = error instanceof UsageError ? error.code : 'unavailable';
      if (['credential-required', 'source-credential-required'].includes(status)) status = 'reauth-required';
      if (status === 'billing-credential-required') status = 'needs-permission';
      if (status === 'scope-required') status = id === 'anthropic' ? 'needs-permission' : 'needs-configuration';
      if (status === 'invalid-response') status = 'unavailable';
      if (!['needs-permission', 'needs-configuration', 'reauth-required', 'unsupported', 'rate-limited', 'unavailable'].includes(status)) status = 'unavailable';
      const stale = previous?.snapshot && ['unavailable', 'rate-limited'].includes(status);
      result = { status: stale ? 'stale' : status, ...(stale ? { snapshot: previous.snapshot, lastErrorStatus: status } : {}), lastAttemptAt,
        message: error instanceof UsageError ? error.message : 'The provider usage query could not complete.',
        ...(error.retryAt ? { retryAt: error.retryAt } : status === 'rate-limited' ? { retryAt: new Date(now() + 60000).toISOString() } : {}),
      };
    }
    // Disconnect/reconnect while a request is running cannot revive old snapshots.
    if ((generations.get(id) ?? 0) !== generation) return { status: 'reauth-required', lastAttemptAt };
    const current = await Promise.resolve().then(() => contextFor(id)).catch(() => undefined);
    if (!current || accountFingerprint(current.connection, current.rawGrant ?? { access: current.access }) !== fingerprint) return { status: 'reauth-required', lastAttemptAt };
    await store.write(id, { fingerprint, result }, () => (generations.get(id) ?? 0) === generation);
    if ((generations.get(id) ?? 0) !== generation) return { status: 'reauth-required', lastAttemptAt };
    return result;
  };
  return {
    async get(id, { force = false } = {}) {
      if (inflight.has(id)) return inflight.get(id);
      const pending = query(id, force).finally(() => { if (inflight.get(id) === pending) inflight.delete(id); });
      inflight.set(id, pending); return pending;
    },
    async invalidate(id) {
      generations.set(id, (generations.get(id) ?? 0) + 1);
      inflight.delete(id); await store.delete(id);
    },
  };
}
