import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregatorUsageIds, fetchAggregatorUsage } from './aggregators.js';

const ACCESS = 'fixture-inference';
const BILLING = 'fixture-management';
const DATE = '2026-11-17T04:00:00.000Z';

function mock(responses, extra = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      access: ACCESS, now: Date.parse('2026-11-16T04:00:00.000Z'), ...extra,
      async request(url, options) {
        calls.push({ url, ...options });
        const item = responses[calls.length - 1];
        assert.notEqual(item, undefined, `Unexpected request to ${url}`);
        if (item instanceof Error) throw item;
        return item;
      },
    },
  };
}

function windowBy(result, id) { return result.windows.find(row => row.id === id); }
function noSecrets(result) {
  const json = JSON.stringify(result);
  assert.equal(json.includes(ACCESS), false);
  assert.equal(json.includes(BILLING), false);
}

test('exports only issuer-bound supported adapters and rejects unsupported ids', async () => {
  assert.equal(aggregatorUsageIds.length, 9);
  const { ctx, calls } = mock([]);
  await assert.rejects(fetchAggregatorUsage('__proto__', ctx), e => e.code === 'unsupported');
  await assert.rejects(fetchAggregatorUsage('new-api', ctx), e => e.code === 'unsupported');
  assert.equal(calls.length, 0);
});

test('OpenRouter separates key budgets, shared budgets, free requests, and management-account balance', async () => {
  const { ctx, calls } = mock([
    { data: { limit: 10, limit_reset: 'daily', limit_remaining: -2, usage: 100, usage_daily: 12, usage_weekly: 50, budgets: [{ scope: 'workspace', limit_usd: 100, spend_usd: 110, remaining_usd: -10, resets_at: DATE }], effective_budget: { scope: 'workspace', limit_usd: 100, spend_usd: 110, remaining_usd: -10 }, free_model_daily_requests: { used: 2, limit: 50, remaining: 48 } } },
    { data: { total_credits: 20, total_usage: 22 } },
  ], { billingAccess: BILLING });
  const out = await fetchAggregatorUsage('openrouter', ctx);
  assert.equal(windowBy(out, 'key-limit').used, 12);
  assert.equal(windowBy(out, 'key-limit').remaining, -2);
  assert.equal(windowBy(out, 'budget-0').remaining, -10);
  assert.equal(windowBy(out, 'budget-0').scope, 'workspace');
  assert.equal(windowBy(out, 'free-model-daily').unit, 'requests');
  assert.equal(out.balances[0].amount, -2);
  assert.equal(calls[0].headers.Authorization, `Bearer ${ACCESS}`);
  assert.equal(calls[1].headers.Authorization, `Bearer ${BILLING}`);
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/credits');
  noSecrets(out);
});

test('OpenRouter preserves successful key data when optional billing access fails', async () => {
  const denied = Object.assign(new Error(`forbidden ${BILLING}`), { status: 403 });
  const { ctx } = mock([{ data: { limit: null, usage: 3 } }, denied], { billingAccess: BILLING });
  const out = await fetchAggregatorUsage('openrouter', ctx);
  assert.equal(out.status, 'partial');
  assert.equal(windowBy(out, 'key-limit').unlimited, true);
  assert.equal(out.balances.length, 0);
  assert.equal(windowBy(out, 'key-limit').remaining, undefined);
  noSecrets(out);
});

test('OpenRouter never sends a normal key to management credits automatically', async () => {
  const { ctx, calls } = mock([{ data: { limit: 0, usage: 0, limit_remaining: 0 } }]);
  const out = await fetchAggregatorUsage('openrouter', ctx);
  assert.equal(calls.length, 1);
  assert.equal(out.status, 'partial');
  assert.equal(windowBy(out, 'key-limit').remaining, 0);
});

test('NanoGPT handles fraction percentages, millisecond windows, and image/token units separately', async () => {
  const { ctx, calls } = mock([{
    active: true, limits: { weeklyInputTokens: 1000, dailyImages: 100 },
    weeklyInputTokens: { used: 2.5, remaining: 997.5, percentUsed: 0.0025, resetAt: Date.parse(DATE) },
    dailyImages: { used: 4, remaining: 96, percentUsed: 0.04, resetAt: Date.parse(DATE) },
    dailyInputTokens: null,
    routing: { recommendedMode: 'subscription', subscriptionQuotaAvailable: true },
  }]);
  const out = await fetchAggregatorUsage('nanogpt', ctx);
  assert.equal(windowBy(out, 'weeklyInputTokens').usedPercent, 0.25);
  assert.equal(windowBy(out, 'weeklyInputTokens').resetAt, DATE);
  assert.equal(windowBy(out, 'weeklyInputTokens').unit, 'tokens');
  assert.equal(windowBy(out, 'dailyImages').unit, 'credits');
  assert.equal(windowBy(out, 'dailyInputTokens'), undefined);
  assert.equal(out.balances.length, 0);
  assert.equal(calls[0].url, 'https://api.nano-gpt.com/api/subscription/v1/usage');
});

test('NanoGPT degraded quotas remain unknown despite an advertised limit', async () => {
  const { ctx } = mock([{ active: true, limits: { weeklyInputTokens: 60000000 }, weeklyInputTokens: { used: null, remaining: null, percentUsed: null, degraded: true }, routing: { subscriptionQuotaAvailable: null } }]);
  const out = await fetchAggregatorUsage('nanogpt', ctx);
  assert.equal(out.status, 'partial');
  assert.equal(out.windows.length, 0);
  assert.equal(out.balances.length, 0);
});

test('NanoGPT trials and overage retain source direction without clearing unknown values', async () => {
  const { ctx } = mock([{ active: false, tokenLimits: { total: 10 }, tokens: { used: 12, remaining: -2, percentUsed: 1.2, resetAt: null }, usageUnits: 'tokens' }]);
  const row = windowBy(await fetchAggregatorUsage('nanogpt', ctx), 'tokens');
  assert.equal(row.usedPercent, 120);
  assert.equal(row.remaining, -2);
  assert.equal(row.resetAt, undefined);
});

test('ZenMux requires explicit management access without trying inference key', async () => {
  const { ctx, calls } = mock([]);
  await assert.rejects(fetchAggregatorUsage('zenmux', ctx), e => e.code === 'needs-permission');
  assert.equal(calls.length, 0);
});

test('ZenMux preserves Flow units and cap-only month, with independent PAYG components', async () => {
  const { ctx, calls } = mock([
    { success: true, data: { plan: { tier: 'pro' }, quota_5_hour: { max_flows: 800, used_flows: 57.2, remaining_flows: 742.8, usage_percentage: 0.0715, resets_at: DATE }, quota_7_day: { max_flows: 6182, usage_percentage: 0.01, resets_at: null }, quota_monthly: { max_flows: 34560, max_value_usd: 1134.33 } } },
    { success: true, data: { currency: 'usd', total_credits: '482.74', top_up_credits: '35.0', bonus_credits: '447.74' } },
  ], { billingAccess: BILLING });
  const out = await fetchAggregatorUsage('zenmux', ctx);
  assert.equal(windowBy(out, 'quota_5_hour').usedPercent, 7.1499999999999995);
  assert.equal(windowBy(out, 'quota_5_hour').unit, 'credits');
  assert.equal(windowBy(out, 'monthly-cap').limit, 34560);
  assert.equal(windowBy(out, 'monthly-cap').used, undefined);
  assert.equal(windowBy(out, 'monthly-cap').remaining, undefined);
  assert.equal(windowBy(out, 'monthly-cap').usedPercent, undefined);
  assert.equal(out.balances.length, 3);
  assert.equal(out.balances[0].amount, '482.74');
  assert.ok(calls.every(c => c.headers.Authorization === `Bearer ${BILLING}`));
  noSecrets(out);
});

test('ZenMux preserves good PAYG balance when subscription fetch is unavailable', async () => {
  const { ctx } = mock([new Error('subscription unavailable'), { success: true, data: { total_credits: 0, top_up_credits: 0, bonus_credits: 0 } }], { billingAccess: BILLING });
  const out = await fetchAggregatorUsage('zenmux', ctx);
  assert.equal(out.status, 'partial');
  assert.equal(out.balances[0].amount, 0);
  assert.equal(out.windows.length, 0);
});

test('ZenMux documented management 422 throttling maps to rate-limited without exposing server text', async () => {
  const limited = Object.assign(new Error(`supplier says ${BILLING}`), { status: 422, retryAt: DATE });
  const { ctx } = mock([limited, limited], { billingAccess: BILLING });
  await assert.rejects(fetchAggregatorUsage('zenmux', ctx), error => error.code === 'rate-limited' && error.retryAt === DATE && !error.message.includes(BILLING));
});

test('OpenCode refuses missing workspace and uses Go-specific organization header', async () => {
  const empty = mock([]);
  await assert.rejects(fetchAggregatorUsage('opencode-go', empty.ctx), e => e.code === 'needs-configuration');
  assert.equal(empty.calls.length, 0);
  const { ctx, calls } = mock([{ usage: { rolling: { percent: 0.5, status: 'ok', resetsAt: DATE }, weekly: { percent: 100, status: 'rate-limited', resetsAt: DATE }, monthly: { percent: 20, status: 'ok', resetsAt: DATE } } }], { organizationId: 'workspace_123' });
  const out = await fetchAggregatorUsage('opencode-go', ctx);
  assert.equal(calls[0].headers['x-opencode-org-id'], 'workspace_123');
  assert.equal(calls[0].headers['x-org-id'], undefined);
  assert.equal(windowBy(out, 'rolling').usedPercent, 0.5);
  assert.equal(windowBy(out, 'rolling').resetAt, DATE);
  assert.equal(windowBy(out, 'rolling').scope, 'workspace:workspace_123:member');
  assert.equal(windowBy(out, 'monthly').windowSeconds, undefined);
});

test('OpenCode Zen preserves shared and per-model budget scopes without summing', async () => {
  const { ctx, calls } = mock([[
    { ruleID: 'shared', scope: 'combined', per: 'set', limitDollars: 100, spentDollars: 90, resetsAt: DATE },
    { ruleID: 'models', scope: 'each', per: 'model', limitDollars: 5, spentDollars: 4, resetsAt: DATE, models: [{ modelID: 'm1', spentDollars: 4 }, { modelID: 'm2', spentDollars: 2 }] },
  ]], { rawGrant: { metadata: { orgID: 'org_123' } } });
  const out = await fetchAggregatorUsage('opencode-zen', ctx);
  assert.equal(calls[0].headers['x-org-id'], 'org_123');
  assert.equal(calls[0].headers['x-opencode-org-id'], undefined);
  assert.equal(out.windows.length, 3);
  assert.equal(out.windows[0].scope, 'workspace:org_123:shared');
  assert.equal(out.windows[1].remaining, 1);
  assert.equal(out.windows[2].remaining, 3);
  assert.equal(out.balances.length, 0);
});

test('OpenCode empty budgets do not imply zero balance or unlimited allowance', async () => {
  const { ctx } = mock([[]], { workspaceId: 'w' });
  const out = await fetchAggregatorUsage('opencode-zen', ctx);
  assert.equal(out.windows.length, 0);
  assert.equal(out.balances.length, 0);
});

test('Kilo requests only credit and Pass reads, propagates org, scales micro-USD correctly', async () => {
  const { ctx, calls } = mock([[
    { result: { data: { json: { creditBlocks: [{ amount_mUsd: 10000000, balance_mUsd: 2500000 }, { amount_mUsd: 5000000, balance_mUsd: 0 }], totalBalance_mUsd: 2500000 } } } },
    { result: { data: { json: { subscription: { tier: 'tier_19', currentPeriodUsageUsd: 7, currentPeriodBaseCreditsUsd: 19, currentPeriodBonusCreditsUsd: 2, nextBillingAt: DATE } } } } },
  ]], { organizationId: 'org_123' });
  const out = await fetchAggregatorUsage('kilo', ctx);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://app.kilo.ai');
  assert.equal(url.pathname, '/api/trpc/user.getCreditBlocks,kiloPass.getState');
  assert.deepEqual(JSON.parse(url.searchParams.get('input')), { 0: { json: null }, 1: { json: null } });
  assert.equal(calls[0].headers['X-KILOCODE-ORGANIZATIONID'], 'org_123');
  assert.equal(out.balances[0].amount, 2.5);
  assert.equal(windowBy(out, 'pass-cycle').limit, 21);
  assert.equal(windowBy(out, 'pass-cycle').remaining, 14);
  assert.equal(windowBy(out, 'pass-cycle').resetAt, undefined);
  assert.equal(out.plan.renewsAt, DATE);
  noSecrets(out);
});

test('Kilo never invents zero used or a full allowance from balance-only or missing bonus', async () => {
  const { ctx } = mock([[
    { result: { data: { json: { totalBalance_mUsd: 0, creditBlocks: [] } } } },
    { result: { data: { json: { subscription: { currentPeriodUsageUsd: 4, currentPeriodBaseCreditsUsd: 19 } } } } },
  ]]);
  const out = await fetchAggregatorUsage('kilo', ctx);
  assert.equal(out.balances[0].amount, 0);
  assert.equal(windowBy(out, 'pass-cycle').limit, undefined);
  assert.equal(windowBy(out, 'pass-cycle').remaining, undefined);
});

test('Kilo keeps successful credit query when Pass batch entry is denied without exposing errors', async () => {
  const { ctx } = mock([[
    { result: { data: { json: { totalBalance_mUsd: 1000000 } } } },
    { error: { json: { message: ACCESS, data: { code: 'FORBIDDEN' } } } },
  ]]);
  const out = await fetchAggregatorUsage('kilo', ctx);
  assert.equal(out.status, 'partial');
  assert.equal(out.balances[0].amount, 1);
  noSecrets(out);
});

test('Kilo refuses malformed scope and incomplete block totals', async () => {
  const invalidScope = mock([], { organizationId: 'org\nsecret' });
  await assert.rejects(fetchAggregatorUsage('kilo', invalidScope.ctx), e => e.code === 'needs-configuration');
  assert.equal(invalidScope.calls.length, 0);
  const { ctx } = mock([[
    { result: { data: { json: { creditBlocks: [{ balance_mUsd: 1000000 }, { balance_mUsd: null }] } } } },
    { result: { data: { json: { subscription: null } } } },
  ]]);
  const out = await fetchAggregatorUsage('kilo', ctx);
  assert.equal(out.balances.find(b => b.id === 'account-balance'), undefined);
});

test('Poe reads only combined points; never infers a subscription reset or dollar balance', async () => {
  const { ctx, calls } = mock([{ current_point_balance: 0 }]);
  const out = await fetchAggregatorUsage('poe', ctx);
  assert.equal(out.balances[0].amount, 0);
  assert.equal(out.balances[0].unit, 'credits');
  assert.equal(out.balances[0].currency, undefined);
  assert.equal(out.windows.length, 0);
  assert.equal(calls[0].url, 'https://api.poe.com/usage/current_balance');
});

test('Synthetic gives new weekly schema priority and distinguishes partial regeneration from reset', async () => {
  const { ctx } = mock([{
    planWeeklyLimit: { percentRemaining: 0.5, nextRegenAt: DATE, nextRegenPercent: 2 },
    rollingFiveHourLimit: { max: 135, remaining: 0, nextTickAt: DATE, tickPercent: 2 },
    weeklyTokenLimit: { maxCredits: '24', remainingCredits: '0', percentRemaining: 0, nextRegenAt: DATE },
  }]);
  const out = await fetchAggregatorUsage('synthetic', ctx);
  assert.equal(out.windows.length, 1);
  assert.equal(out.windows[0].remainingPercent, 0.5);
  assert.equal(out.windows[0].resetAt, undefined);
  assert.equal(out.windows[0].nextRegenAt, DATE);
  assert.equal(out.windows[0].nextRegenPercent, 2);
});

test('Synthetic legacy credit quantities are not interpreted as tokens or wallet dollars', async () => {
  const { ctx } = mock([{ weeklyTokenLimit: { maxCredits: '24.00', remainingCredits: '12.00', percentRemaining: 50, nextRegenAt: DATE } }]);
  const out = await fetchAggregatorUsage('synthetic', ctx);
  assert.equal(out.windows[0].unit, 'credits');
  assert.equal(out.windows[0].remaining, 12);
  assert.equal(out.windows[0].resetAt, undefined);
  assert.equal(out.balances.length, 0);
});

test('Chutes uses service-returned fixed-bucket reset and monetary-equivalent lanes', async () => {
  const { ctx, calls } = mock([{ subscription: true, custom: false, monthly_price: 10, four_hour: { usage: 4.17, cap: 4.17, remaining: 0, reset_at: DATE }, monthly: { usage: 30, cap: 50, remaining: 20, reset_at: '2026-12-01T00:00:00Z' } }]);
  const out = await fetchAggregatorUsage('chutes', ctx);
  assert.equal(out.windows[0].unit, 'money');
  assert.equal(out.windows[0].remaining, 0);
  assert.equal(out.windows[0].resetAt, DATE);
  assert.equal(out.windows[0].windowSeconds, 14400);
  assert.equal(out.balances.length, 0);
  assert.equal(calls[0].url, 'https://api.chutes.ai/users/me/subscription_usage');
});

test('Chutes custom monthly uncapped does not erase the burst cap', async () => {
  const { ctx } = mock([{ subscription: true, custom: true, four_hour: { usage: 1, cap: 5, remaining: 4 }, monthly: { uncapped: true } }]);
  const out = await fetchAggregatorUsage('chutes', ctx);
  assert.equal(windowBy(out, 'monthly').unlimited, true);
  assert.equal(windowBy(out, 'monthly').remaining, undefined);
  assert.equal(windowBy(out, 'four_hour').limit, 5);
});

test('Chutes no-subscription response does not imply zero PAYG balance', async () => {
  const { ctx } = mock([{ subscription: false }]);
  const out = await fetchAggregatorUsage('chutes', ctx);
  assert.equal(out.windows.length, 0);
  assert.equal(out.balances.length, 0);
});

test('each adapter rejects unrecognized, null and nonfinite metrics without inventing allowances', async () => {
  for (const id of aggregatorUsageIds) {
    const responses = id === 'zenmux' ? [{ data: {} }, { data: {} }] : id === 'kilo' ? [[{ result: { data: { json: {} } } }, { result: { data: { json: {} } } }]] : [{}];
    const { ctx } = mock(responses, { billingAccess: BILLING, workspaceId: 'test' });
    await assert.rejects(fetchAggregatorUsage(id, ctx), e => e.code === 'invalid-response', id);
  }
  for (const value of [null, '', false, Infinity, 'NaN']) {
    const { ctx } = mock([{ current_point_balance: value }]);
    await assert.rejects(fetchAggregatorUsage('poe', ctx), e => e.code === 'invalid-response');
  }
});

test('empty or multiline credentials are rejected before a transport call', async () => {
  for (const access of ['', '   ', 'key\nvalue', null]) {
    const { ctx, calls } = mock([], { access });
    await assert.rejects(fetchAggregatorUsage('poe', ctx), e => e.code === 'needs-configuration');
    assert.equal(calls.length, 0);
  }
});
