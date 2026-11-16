import { finite, iso, quotaWindow, balance, UsageError } from './core.js';

// Supplier contracts are intentionally issuer-bound. Never derive a billing
// endpoint from an inference base URL or send management keys to model routes.
export const aggregatorUsageIds = Object.freeze([
  'openrouter', 'nanogpt', 'zenmux', 'opencode-go', 'opencode-zen',
  'kilo', 'poe', 'synthetic', 'chutes',
]);

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const number = value => value == null || typeof value === 'boolean' || value === '' ? undefined : finite(value);
const decimal = value => number(value) === undefined ? undefined : value;
const hasMetric = row => ['used', 'limit', 'remaining', 'usedPercent', 'remainingPercent'].some(key => number(row[key]) !== undefined) || row.unlimited === true;
const snapshot = () => ({ windows: [], balances: [], notes: [], status: 'fresh' });
const partial = (out, note) => { out.status = 'partial'; out.notes.push(note); };
const window = (out, row) => { if (hasMetric(row)) out.windows.push(quotaWindow(row)); };
const wallet = (out, row) => { if (decimal(row.amount) !== undefined) out.balances.push(balance(row)); };
const invalid = () => new UsageError('invalid-response', 'The usage service returned no recognized quota data.');
const requireAccess = value => {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw new UsageError('needs-configuration', 'A valid usage credential is required.', { status: 400 });
  }
  return value;
};
const bearer = access => ({ Authorization: `Bearer ${requireAccess(access)}`, Accept: 'application/json' });
const read = (ctx, url, access = ctx.access, headers = {}) => ctx.request(url, { method: 'GET', headers: { ...bearer(access), ...headers } });
const scopeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined;

function finish(out, recognized = false) {
  if (!out.windows.length && !out.balances.length && !recognized) throw invalid();
  if (!out.notes.length) delete out.notes;
  return out;
}

async function openrouter(ctx) {
  const data = object(object(await read(ctx, 'https://openrouter.ai/api/v1/key')).data);
  const out = snapshot();
  const period = ({ daily: 'usage_daily', weekly: 'usage_weekly', monthly: 'usage_monthly' })[data.limit_reset];
  const used = number(period ? data[period] : data.usage);
  window(out, {
    id: 'key-limit', label: 'API key budget (USD)', unit: 'money', scope: 'api-key',
    used, limit: number(data.limit), remaining: number(data.limit_remaining),
    unlimited: data.limit === null,
  });
  for (const name of ['daily', 'weekly', 'monthly']) {
    window(out, { id: `key-spend-${name}`, label: `${name} API key spend (USD)`, unit: 'money', scope: 'api-key', used: number(data[`usage_${name}`]) });
  }
  const budgets = Array.isArray(data.budgets) ? data.budgets : [];
  for (const [i, raw] of budgets.slice(0, 100).entries()) {
    const b = object(raw);
    window(out, {
      id: `budget-${i}`, label: 'Applicable budget (USD)', unit: 'money',
      scope: ['organization', 'member', 'workspace', 'key'].includes(b.scope) ? b.scope : 'api-key',
      used: number(b.spend_usd), limit: number(b.limit_usd), remaining: number(b.remaining_usd),
      resetAt: iso(b.resets_at, 'iso'),
    });
  }
  if (object(data.effective_budget).limit_usd != null) {
    const b = data.effective_budget;
    window(out, { id: 'effective-budget', label: 'Effective budget (USD; overlaps applicable budgets)', unit: 'money', scope: ['organization', 'member', 'workspace', 'key'].includes(b.scope) ? b.scope : 'api-key', used: number(b.spend_usd), limit: number(b.limit_usd), remaining: number(b.remaining_usd), resetAt: iso(b.resets_at, 'iso') });
  }
  const free = object(data.free_model_daily_requests);
  window(out, { id: 'free-model-daily', label: 'Free model daily requests', unit: 'requests', scope: 'account', used: number(free.used), limit: number(free.limit), remaining: number(free.remaining) });
  if (ctx.billingAccess) {
    try {
      const billing = object(object(await read(ctx, 'https://openrouter.ai/api/v1/credits', ctx.billingAccess)).data);
      const total = number(billing.total_credits);
      const spent = number(billing.total_usage);
      if (total === undefined || spent === undefined) throw invalid();
      // This credential can belong to a separate account. Keep its provenance
      // distinct; the host binds it to an account before presenting a union.
      wallet(out, { id: 'billing-account', label: 'Management credential account balance', amount: total - spent, currency: 'USD', unit: 'money', scope: 'billing-account' });
      out.notes.push('management-balance-has-independent-account-scope');
    } catch {
      partial(out, 'account-balance-unavailable');
    }
  } else partial(out, 'account-balance-needs-permission');
  return finish(out);
}

async function nanogpt(ctx) {
  const data = object(await read(ctx, 'https://api.nano-gpt.com/api/subscription/v1/usage'));
  const out = snapshot();
  const limits = object(data.limits);
  for (const [id, unit, label] of [
    ['dailyInputTokens', 'tokens', 'Daily input token allowance'],
    ['weeklyInputTokens', 'tokens', 'Weekly input token allowance'],
    ['dailyImages', 'credits', 'Daily image allowance (images)'],
    ['tokens', 'tokens', 'Trial token allowance'],
  ]) {
    const row = object(data[id]);
    if (row.degraded === true) { partial(out, `${id}-unavailable`); continue; }
    window(out, {
      id, label, unit, scope: 'account:subscription', used: number(row.used), remaining: number(row.remaining),
      limit: number(id === 'tokens' ? object(data.tokenLimits).total : limits[id]),
      usedPercent: number(row.percentUsed) === undefined ? undefined : number(row.percentUsed) * 100,
      resetAt: iso(row.resetAt, 'milliseconds'),
    });
  }
  if (typeof data.active === 'boolean') out.notes.push(data.active ? 'subscription-active' : 'subscription-inactive');
  const route = object(data.routing);
  if (['subscription', 'paygo', 'unavailable'].includes(route.recommendedMode)) out.notes.push(`billing-route-${route.recommendedMode}`);
  if (route.subscriptionQuotaAvailable === null) partial(out, 'subscription-quota-unknown');
  // Cash balances require a different endpoint and are not implied by active
  // subscription status. The management-only token is a different credential.
  return finish(out, typeof data.active === 'boolean' || out.status === 'partial');
}

async function zenmux(ctx) {
  if (!ctx.billingAccess) throw new UsageError('needs-permission', 'ZenMux usage requires a Management API key.', { status: 403 });
  requireAccess(ctx.billingAccess);
  const out = snapshot();
  let recognized = false;
  const managementRead = async url => {
    try { return await read(ctx, url, ctx.billingAccess); }
    catch (error) {
      // ZenMux documents HTTP 422 for its management rate limits; the shared
      // transport cannot apply that provider-specific meaning globally.
      if (error?.status === 422) throw new UsageError('rate-limited', 'ZenMux management usage is temporarily rate limited.', { status: 422, retryAt: error.retryAt });
      throw error;
    }
  };
  const responses = await Promise.allSettled([
    managementRead('https://zenmux.ai/api/v1/management/subscription/detail'),
    managementRead('https://zenmux.ai/api/v1/management/payg/balance'),
  ]);
  if (responses[0].status === 'fulfilled') {
    const root = object(responses[0].value);
    const data = root.success === false ? {} : object(root.data);
    const tier = object(data.plan).tier;
    if (['free', 'pro', 'max', 'ultra'].includes(tier)) { out.plan = { id: tier, name: `ZenMux ${tier}` }; recognized = true; }
    for (const [key, seconds, label] of [['quota_5_hour', 18000, 'Five-hour Flows'], ['quota_7_day', 604800, 'Seven-day Flows']]) {
      const row = object(data[key]);
      window(out, { id: key, label, unit: 'credits', scope: 'account:subscription', used: number(row.used_flows), limit: number(row.max_flows), remaining: number(row.remaining_flows), usedPercent: number(row.usage_percentage) === undefined ? undefined : number(row.usage_percentage) * 100, resetAt: iso(row.resets_at, 'iso'), windowSeconds: seconds });
    }
    window(out, { id: 'monthly-cap', label: 'Monthly Flows cap (usage unavailable)', unit: 'credits', scope: 'account:subscription', limit: number(object(data.quota_monthly).max_flows) });
    if (!out.windows.length && !recognized) partial(out, 'subscription-detail-unavailable');
    else out.notes.push('monthly-usage-not-provided');
  } else partial(out, 'subscription-detail-unavailable');
  if (responses[1].status === 'fulfilled') {
    const root = object(responses[1].value);
    const data = root.success === false ? {} : object(root.data);
    for (const [field, id, label] of [['total_credits', 'payg-total', 'Total PAYG balance'], ['top_up_credits', 'payg-top-up', 'Top-up balance (part of total)'], ['bonus_credits', 'payg-bonus', 'Bonus balance (part of total)']]) {
      wallet(out, { id, label, unit: 'money', currency: 'USD', amount: decimal(data[field]), scope: 'account:payg' });
    }
    if (!out.balances.length) partial(out, 'payg-balance-unavailable');
  } else partial(out, 'payg-balance-unavailable');
  if (!recognized && !out.windows.length && !out.balances.length) {
    const rejected = responses.find(r => r.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
  return finish(out, recognized);
}

function opencodeScope(ctx) {
  const id = scopeId(ctx.workspaceId) || scopeId(ctx.organizationId) || scopeId(object(object(ctx.rawGrant).metadata).orgID) || scopeId(object(ctx.rawGrant).org_id);
  if (!id) throw new UsageError('needs-configuration', 'Select the OpenCode workspace before querying usage.', { status: 400 });
  return id;
}

async function opencode(ctx, go) {
  const id = opencodeScope(ctx);
  const out = snapshot();
  if (go) {
    const data = object(object(await read(ctx, 'https://opencode.ai/zen/go/v1/usage', ctx.access, { 'x-opencode-org-id': id })).usage);
    for (const [name, label, seconds] of [['rolling', 'Go five-hour allowance', 18000], ['weekly', 'Go weekly allowance', 604800], ['monthly', 'Go monthly allowance', undefined]]) {
      const row = object(data[name]);
      window(out, { id: name, label, unit: 'percent', scope: `workspace:${id}:member`, usedPercent: number(row.percent), resetAt: iso(row.resetsAt, 'iso'), windowSeconds: seconds });
      if (row.status === 'rate-limited') out.notes.push(`${name}-rate-limited`);
    }
    return finish(out);
  }
  const budgets = await read(ctx, 'https://opencode.ai/console/api/policies/current-budgets', ctx.access, { 'x-org-id': id });
  if (!Array.isArray(budgets)) throw invalid();
  for (const [i, raw] of budgets.slice(0, 100).entries()) {
    const row = object(raw);
    const scope = `workspace:${id}:${row.scope === 'combined' ? 'shared' : 'member'}`;
    if (row.per === 'model') {
      // spentDollars is the maximum model's usage, not the sum; preserve each
      // independently constrained model when the server supplies its spend.
      for (const [j, model] of (Array.isArray(row.models) ? row.models : []).slice(0, 200).entries()) {
        window(out, { id: `budget-${i}-model-${j}`, label: `Model budget ${i + 1}.${j + 1} (USD)`, unit: 'money', scope: `${scope}:model`, used: number(object(model).spentDollars), limit: number(row.limitDollars), resetAt: iso(row.resetsAt, 'iso') });
      }
      if (!row.models?.length) out.notes.push('per-model-budget-details-unavailable');
    } else {
      window(out, { id: `budget-${i}`, label: 'Workspace budget (USD)', unit: 'money', scope, used: number(row.spentDollars), limit: number(row.limitDollars), resetAt: iso(row.resetsAt, 'iso') });
    }
  }
  out.notes.push('workspace-wallet-not-included');
  return finish(out, budgets.length === 0);
}

function trpcPayload(entry) {
  const value = object(entry);
  if (value.error) return undefined;
  const result = object(value.result);
  const data = object(result.data);
  return Object.hasOwn(data, 'json') ? data.json : (result.data ?? result.json);
}

async function kilo(ctx) {
  const url = new URL('https://app.kilo.ai/api/trpc/user.getCreditBlocks,kiloPass.getState');
  url.searchParams.set('batch', '1');
  url.searchParams.set('input', JSON.stringify({ 0: { json: null }, 1: { json: null } }));
  const organization = ctx.organizationId == null ? undefined : scopeId(ctx.organizationId);
  if (ctx.organizationId != null && !organization) throw new UsageError('needs-configuration', 'Invalid Kilo organization scope.', { status: 400 });
  const root = await read(ctx, url.href, ctx.access, organization ? { 'X-KILOCODE-ORGANIZATIONID': organization } : {});
  const entries = Array.isArray(root) ? root : object(root);
  const credits = object(trpcPayload(entries[0]));
  const pass = object(trpcPayload(entries[1]));
  const out = snapshot();
  const scope = organization ? `organization:${organization}` : 'account';
  const blocks = Array.isArray(credits.creditBlocks) ? credits.creditBlocks : undefined;
  const totalBalance = number(credits.totalBalance_mUsd);
  if (totalBalance !== undefined) wallet(out, { id: 'account-balance', label: 'Total credit balance', unit: 'money', currency: 'USD', amount: totalBalance / 1_000_000, scope });
  if (blocks) {
    // Do not sum a subset of malformed blocks into an apparently complete total.
    if (totalBalance === undefined && blocks.length && blocks.every(b => number(object(b).balance_mUsd) !== undefined)) {
      wallet(out, { id: 'account-balance', label: 'Total credit-block balance', unit: 'money', currency: 'USD', amount: blocks.reduce((sum, b) => sum + number(b.balance_mUsd) / 1_000_000, 0), scope });
    }
    for (const [i, raw] of blocks.slice(0, 200).entries()) {
      const b = object(raw);
      wallet(out, { id: `credit-block-${i}`, label: `Credit block ${i + 1} (part of account balance)`, unit: 'money', currency: 'USD', amount: number(b.balance_mUsd) === undefined ? undefined : number(b.balance_mUsd) / 1_000_000, scope });
    }
  }
  const sub = Object.hasOwn(pass, 'subscription') ? object(pass.subscription) : pass;
  const used = number(sub.currentPeriodUsageUsd);
  const base = number(sub.currentPeriodBaseCreditsUsd);
  const bonus = number(sub.currentPeriodBonusCreditsUsd);
  // An absent bonus field is unknown, not an implicit zero-credit grant.
  const limit = base !== undefined && bonus !== undefined ? base + bonus : undefined;
  window(out, { id: 'pass-cycle', label: 'Pass current cycle credits (USD)', unit: 'money', scope: `${scope}:pass`, used, limit });
  if (base !== undefined) window(out, { id: 'pass-base', label: 'Pass base allotment (USD; included in cycle)', unit: 'money', scope: `${scope}:pass`, limit: base });
  if (bonus !== undefined) window(out, { id: 'pass-bonus', label: 'Pass bonus allotment (USD; included in cycle)', unit: 'money', scope: `${scope}:pass`, limit: bonus });
  if (used !== undefined || base !== undefined || bonus !== undefined) {
    out.plan = { name: 'Kilo Pass' };
    const renewal = [sub.nextBillingAt, sub.nextRenewalAt, sub.renewsAt, sub.renewAt].map(v => iso(v, 'iso')).find(Boolean);
    if (renewal) out.plan.renewsAt = renewal;
  }
  if (!trpcPayload(entries[0])) partial(out, 'credit-balance-unavailable');
  if (!trpcPayload(entries[1])) partial(out, 'pass-detail-unavailable');
  out.notes.push('internal-billing-api');
  return finish(out, pass.subscription === null && out.status === 'fresh');
}

async function poe(ctx) {
  const data = object(await read(ctx, 'https://api.poe.com/usage/current_balance'));
  const out = snapshot();
  wallet(out, { id: 'points', label: 'Combined subscription and add-on points', amount: decimal(data.current_point_balance), unit: 'credits', scope: 'account' });
  out.notes.push('points-balance-not-currency', 'subscription-split-and-reset-not-provided');
  return finish(out);
}

async function synthetic(ctx) {
  const data = object(await read(ctx, 'https://api.synthetic.new/v2/quotas'));
  const out = snapshot();
  const current = object(data.planWeeklyLimit);
  if (number(current.percentRemaining) !== undefined) {
    const next = iso(current.nextRegenAt, 'iso');
    window(out, { id: 'weekly', label: 'Weekly plan allowance', unit: 'percent', scope: 'account:subscription', remainingPercent: number(current.percentRemaining), nextRegenAt: next, nextRegenPercent: number(current.nextRegenPercent) });
    out.notes.push('incremental-regeneration-not-full-reset');
  } else {
    const rolling = object(data.rollingFiveHourLimit);
    window(out, { id: 'legacy-five-hour', label: 'Legacy five-hour allowance', unit: 'requests', scope: 'account:subscription', limit: number(rolling.max), remaining: number(rolling.remaining), windowSeconds: 18000 });
    const weekly = object(data.weeklyTokenLimit);
    window(out, { id: 'legacy-weekly', label: 'Legacy weekly credits', unit: 'credits', scope: 'account:subscription', limit: number(weekly.maxCredits), remaining: number(weekly.remainingCredits), remainingPercent: number(weekly.percentRemaining) });
    if (out.windows.length) out.notes.push('legacy-quota-schema', 'incremental-regeneration-not-full-reset');
    const old = object(data.subscription);
    if (!out.windows.length) window(out, { id: 'legacy-subscription', label: 'Legacy subscription requests', unit: 'requests', scope: 'account:subscription', limit: number(old.limit), used: number(old.requests), resetAt: iso(old.renewsAt, 'iso') });
  }
  return finish(out);
}

async function chutes(ctx) {
  const data = object(await read(ctx, 'https://api.chutes.ai/users/me/subscription_usage'));
  const out = snapshot();
  if (data.subscription === false) { out.notes.push('no-subscription', 'payg-balance-not-provided'); return finish(out, true); }
  if (data.subscription !== true) throw invalid();
  for (const [id, label, seconds] of [['four_hour', 'Four-hour PAYG-equivalent allowance (USD)', 14400], ['monthly', 'Monthly PAYG-equivalent allowance (USD)', undefined]]) {
    const row = object(data[id]);
    window(out, { id, label, unit: 'money', scope: 'account:subscription', used: number(row.usage), limit: number(row.cap), remaining: number(row.remaining), unlimited: row.uncapped === true, resetAt: iso(row.reset_at, 'iso'), windowSeconds: seconds });
  }
  out.notes.push('allowance-is-payg-equivalent-not-wallet', 'four-hour-fixed-server-bucket', 'daily-request-quota-not-included');
  return finish(out);
}

export async function fetchAggregatorUsage(id, ctx) {
  if (!aggregatorUsageIds.includes(id)) throw new UsageError('unsupported', 'No usage adapter is available for this platform.');
  if (typeof ctx?.request !== 'function') throw new UsageError('needs-configuration', 'A usage transport is required.', { status: 400 });
  const adapters = { openrouter, nanogpt, zenmux, 'opencode-go': c => opencode(c, true), 'opencode-zen': c => opencode(c, false), kilo, poe, synthetic, chutes };
  return adapters[id](ctx);
}
