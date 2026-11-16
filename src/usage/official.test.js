import test from 'node:test';
import assert from 'node:assert/strict';
import {
  officialUsageIds, fetchOfficialUsage, parseCodexUsage, parseClaudeUsage, parseCopilotUsage,
  parseKimiUsage, parseMiniMaxUsage, resolveMiniMaxCounts, parseZaiUsage, parseAliyunUsage,
  parseAntigravityUsage, parseGeminiUsage, parseXaiUsage, parseNousUsage,
} from './official.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const RESET = '2026-11-17T12:00:00.000Z';
const fixtures = {
  'openai-codex': { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: Date.parse(RESET) / 1000 } }, credits: { balance: '1.25', has_credits: true } },
  anthropic: { five_hour: { utilization: 30, resets_at: RESET }, seven_day: null },
  'github-copilot': { copilot_plan: 'individual', quota_reset_date: '2026-12-01', quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: 80, quota_id: 'premium' } } },
  'kimi-coding': { usages: { limit_5h: { used_ratio: 0.125, reset_time: RESET } } },
  minimax: { model_remains: [{ model_name: 'general', current_interval_total_count: 1000, current_interval_usage_count: 200, current_interval_remaining_percent: 80, start_time: NOW, end_time: NOW + 18000000 }] },
  zai: { code: 200, success: true, data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 30, nextResetTime: Date.parse(RESET) }] } },
  'aliyun-token-plan': { data: { success: true, DataV2: { success: true, data: { per1MonthPercentage: 0.25, per1MonthResetTime: Date.parse(RESET) } } } },
  'google-antigravity': { summary: { groups: [{ displayName: 'Model group', buckets: [{ bucketId: 'weekly', displayName: 'Week', remaining: { remainingFraction: 0.75 }, resetTime: RESET }] }] } },
  'google-gemini-cli': { buckets: [{ modelId: 'model-a', remainingFraction: 0.8, remainingAmount: '120', tokenType: 'REQUESTS', resetTime: RESET }] },
  xai: { config: { creditUsagePercent: 25, subscriptionTier: 'supergrok', currentPeriod: { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' }, prepaidBalance: { val: '1234' } } },
  nous: { subscription: { plan: 'plus', monthly_credits: 100, credits_remaining: 65, current_period_end: RESET }, usage_window: { gauges: [{ id: 'daily', label: 'Daily', scope: 'all', used_bp: 1250, resets_at_ms: Date.parse(RESET) }] }, paid_service_access: { purchased_credits_remaining: 10, total_usable_credits: 75 } },
};
const parsers = {
  'openai-codex': parseCodexUsage, anthropic: parseClaudeUsage, 'github-copilot': parseCopilotUsage,
  'kimi-coding': parseKimiUsage, minimax: parseMiniMaxUsage, zai: parseZaiUsage,
  'aliyun-token-plan': parseAliyunUsage, 'google-antigravity': parseAntigravityUsage,
  'google-gemini-cli': parseGeminiUsage, xai: parseXaiUsage, nous: parseNousUsage,
};

test('all official provider IDs have a parser and a sanitized fixture', () => {
  assert.deepEqual([...officialUsageIds].sort(), Object.keys(fixtures).sort());
  for (const id of officialUsageIds) {
    const input = structuredClone(fixtures[id]);
    const before = JSON.stringify(input);
    const out = parsers[id](input, { now: NOW, projectId: 'project-fixture' });
    assert.ok(out.windows.length || out.balances.length, id);
    assert.equal(JSON.stringify(input), before, `${id}: parser must be pure`);
    assert.equal(out.status, 'fresh');
    assert.equal(JSON.stringify(out).includes('undefined'), false);
  }
});

for (const id of officialUsageIds) {
  test(`${id}: unknown, null, and error-only bodies never become zero quota`, () => {
    for (const input of [{}, null, [], { error: { message: 'sensitive-upstream-message' } }]) {
      assert.throws(() => parsers[id](input, { now: NOW }), error => error.code === 'invalid-response' && !error.message.includes('sensitive'));
    }
  });
  test(`${id}: fixed issuer and selected identity are used by the injected transport`, async () => {
    const calls = [];
    const ctx = {
      access: 'synthetic-access', rawGrant: { access: 'synthetic-github-long-token', accountId: 'account-fixture', scope: 'user:profile user:inference', resourceUrl: 'https://untrusted.example' },
      billingAccess: 'synthetic-console-token', projectId: 'project-fixture', organizationId: 'org-fixture', workspaceId: 'workspace-fixture', region: 'global', now: NOW,
      request: async (url, options) => { calls.push({ url, options }); return structuredClone(fixtures[id]); },
    };
    await fetchOfficialUsage(id, ctx);
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(url.includes('untrusted.example'), false);
    assert.equal(url.includes('synthetic-'), false);
    assert.equal(/onboard|generate|completions/.test(url), false);
    const header = options.headers.Authorization ?? options.headers.authorization;
    assert.equal(header, id === 'github-copilot' ? 'token synthetic-github-long-token' : id === 'zai' ? 'synthetic-access' : `Bearer ${id === 'aliyun-token-plan' ? 'synthetic-console-token' : 'synthetic-access'}`);
    if (id === 'openai-codex') assert.equal(options.headers['ChatGPT-Account-Id'], 'account-fixture');
    if (id === 'zai') { assert.equal(options.headers['bigmodel-organization'], 'org-fixture'); assert.equal(options.headers['bigmodel-project'], 'project-fixture'); assert.ok(url.endsWith('?type=2')); }
    if (id.startsWith('google-')) { assert.equal(options.method, 'POST'); assert.deepEqual(JSON.parse(options.body), { project: 'project-fixture' }); }
    if (id === 'aliyun-token-plan') { const form = new URLSearchParams(options.body); assert.equal(form.get('region'), 'ap-southeast-1'); assert.equal(JSON.parse(form.get('params')).Api, 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'); }
  });
}

test('Codex percentage, duration seconds and absolute reset seconds preserve exact semantics', () => {
  const out = parseCodexUsage(fixtures['openai-codex']);
  assert.equal(out.windows[0].usedPercent, 12.5);
  assert.equal(out.windows[0].remainingPercent, 87.5);
  assert.equal(out.windows[0].windowSeconds, 18000);
  assert.equal(out.windows[0].resetAt, RESET);
  assert.deepEqual(out.balances[0], { id: 'codex:credits', label: 'Codex credits', amount: 1.25, unit: 'credits' });
});

test('Codex additional buckets and relative reset are separate, missing values do not become zero', () => {
  const out = parseCodexUsage({ rate_limit: { primary_window: { reset_after_seconds: 60 } }, additional_rate_limits: [{ limit_name: 'Feature', rate_limit: { secondary_window: { used_percent: 0, reset_after_seconds: 60 } } }] }, { now: NOW });
  assert.equal(out.windows.length, 1);
  assert.equal(out.windows[0].resetAt, new Date(NOW + 60000).toISOString());
  assert.equal(out.windows[0].usedPercent, 0);
  assert.equal(out.windows[0].limit, undefined);
});

test('Claude OAuth usage cents become currency units, explicit null windows stay absent', () => {
  const out = parseClaudeUsage({ five_hour: null, seven_day: { utilization: 0.5 }, extra_usage: { is_enabled: true, used_credits: 123, monthly_limit: 1000, currency: 'USD' } });
  assert.equal(out.windows[0].usedPercent, 0.5);
  assert.equal(out.windows.find(x => x.id === 'claude:extra-usage').used, 1.23);
  assert.equal(out.balances[0].amount, 8.77);
  assert.equal(out.balances[0].currency, 'USD');
});

test('Claude disabled extra usage and invalid scope are not queried or shown', async () => {
  assert.throws(() => parseClaudeUsage({ extra_usage: { is_enabled: false, monthly_limit: 100 } }), { code: 'invalid-response' });
  await assert.rejects(fetchOfficialUsage('anthropic', { access: 'test', rawGrant: { scope: 'user:inference' }, request: () => assert.fail('must not query') }), { code: 'scope-required' });
});

test('Copilot request counters, credit billing, unlimited and zero placeholders remain distinct', () => {
  const requests = parseCopilotUsage(fixtures['github-copilot']);
  assert.equal(requests.windows[0].unit, 'requests');
  assert.equal(requests.windows[0].used, 60);
  assert.equal(requests.windows[0].resetAt, '2026-12-01T00:00:00.000Z');
  const credits = parseCopilotUsage({ token_based_billing: true, copilot_plan: 'business', quota_snapshots: {
    premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, credits_used: 12.5 },
    chat: { unlimited: true },
  } });
  assert.equal(credits.windows[0].used, 12.5);
  assert.equal(credits.windows[0].limit, undefined);
  assert.equal(credits.windows[0].usedPercent, undefined);
  assert.equal(credits.windows[1].unlimited, true);
  assert.equal(credits.windows[1].usedPercent, undefined);
  const placeholder = parseCopilotUsage({ copilot_plan: 'business', quota_snapshots: { chat: { entitlement: 0, remaining: 0, percent_remaining: 100 } } });
  assert.equal(placeholder.windows.length, 0);
  assert.equal(placeholder.status, 'partial');
});

test('Copilot mirrored credit pools are not added twice and short inference token is never fallback', async () => {
  const row = { quota_id: 'one-pool', entitlement: 100, remaining: 90 };
  assert.equal(parseCopilotUsage({ quota_snapshots: { chat: row, completions: row } }).windows.length, 1);
  await assert.rejects(fetchOfficialUsage('github-copilot', { access: 'short-inference-token', request: () => assert.fail('must not query') }), { code: 'source-credential-required' });
});

test('Kimi keeps all observed buckets and converts fixed-point booster amounts without rounding', () => {
  const out = parseKimiUsage({ usages: { limit_month_total: { used_ratio: '0.5', reset_time: RESET }, limit_month_code: { used_ratio: 0 } }, boosterWallet: {
    balance: { type: 'BOOSTER', amount: '1000000000', amountLeft: '123456789' },
    monthlyChargeLimitEnabled: true, monthlyChargeLimit: { priceInCents: 2000, currency: 'USD' }, monthlyUsed: { priceInCents: 150, currency: 'USD' },
  } });
  assert.equal(out.windows[0].usedPercent, 50);
  assert.equal(out.windows[1].usedPercent, 0);
  assert.equal(out.balances[0].amount, 1.23456789);
  assert.equal(out.windows.find(x => x.id === 'kimi:extra-monthly').used, 1.5);
  assert.equal(out.windows.find(x => x.id === 'kimi:extra-monthly').limit, 20);
});

test('Kimi missing wallet fields are not invented and non-booster money is ignored', () => {
  const out = parseKimiUsage({ ...fixtures['kimi-coding'], boosterWallet: { balance: { type: 'BOOSTER', amount: 1000000 } } });
  assert.equal(out.balances.length, 0);
  assert.equal(out.windows.length, 1);
  assert.throws(() => parseKimiUsage({ boosterWallet: { balance: { type: 'OTHER', amountLeft: 1000 } } }), { code: 'invalid-response' });
});

test('MiniMax official ambiguity algorithm handles consumed, remaining, mismatch, and legacy fields', () => {
  for (const reported of [200, 800]) assert.deepEqual(resolveMiniMaxCounts(reported, 1000, 80), { used: 200, limit: 1000, remaining: 800 });
  assert.equal(resolveMiniMaxCounts(200, 1000, 50), undefined);
  assert.deepEqual(resolveMiniMaxCounts(200, 1000), { used: 800, limit: 1000, remaining: 200 });
  for (const args of [[0, 0], [-1, 10], [11, 10], ['', 10], [true, 10]]) assert.equal(resolveMiniMaxCounts(...args), undefined);
  const out = parseMiniMaxUsage({ model_remains: [{ model_name: 'general', current_interval_total_count: 1000, current_interval_usage_count: 200, current_interval_remaining_percent: 50 }] });
  assert.equal(out.windows[0].unit, 'percent');
  assert.equal(out.windows[0].remainingPercent, 50);
  assert.equal(out.windows[0].remaining, undefined);
});

test('MiniMax milliseconds, excluded services, unlimited windows and weekly boosts are preserved', () => {
  const included = { model_name: 'video', current_interval_status: 3, current_weekly_total_count: 100, current_weekly_usage_count: 50, current_weekly_remaining_percent: 50, weekly_boost_permille: 1500, weekly_start_time: NOW, weekly_end_time: NOW + 604800000 };
  const excluded = { model_name: 'not-in-plan', current_interval_total_count: 0, current_weekly_total_count: 0, current_interval_status: 3, current_weekly_status: 3 };
  const out = parseMiniMaxUsage({ model_remains: [excluded, included] });
  assert.equal(out.windows.length, 2);
  assert.equal(out.windows[0].unlimited, true);
  assert.equal(out.windows[1].windowSeconds, 604800);
  assert.equal(out.windows[1].resetAt, new Date(NOW + 604800000).toISOString());
  assert.equal(out.windows[1].remainingPercent, 50);
  assert.ok(out.notes.some(note => note.includes('1.5')));
});

test('ZAI percentages are not mislabeled raw tokens and tools use request counters', () => {
  const out = parseZaiUsage({ success: true, data: { level: 'max', limits: [{ type: 'CREDIT_LIMIT', percentage: 1, unit: 6, number: 1 }, { type: 'TIME_LIMIT', usage: 100, currentValue: 7, remaining: 93, unit: 5, number: 1 }] } }, { organizationId: 'team', projectId: 'proj' });
  assert.equal(out.windows[0].unit, 'percent');
  assert.equal(out.windows[0].usedPercent, 1);
  assert.equal(out.windows[0].windowSeconds, 604800);
  assert.equal(out.windows[1].unit, 'requests');
  assert.equal(out.windows[1].remaining, 93);
  assert.equal(out.windows[1].resetAt, undefined);
  assert.match(out.windows[0].scope, /organization:team\/project:proj/);
});

test('ZAI rejects incomplete team scope and HTTP-200 API failures safely', async () => {
  await assert.rejects(fetchOfficialUsage('zai', { access: 'key', organizationId: 'team', request: () => assert.fail('must not query') }), { code: 'scope-required' });
  assert.throws(() => parseZaiUsage({ success: false, msg: 'secret', data: fixtures.zai.data }), error => error.code === 'invalid-response' && !error.message.includes('secret'));
});

test('Aliyun dynamically parses current windows and refuses error envelopes or no-quota markers', () => {
  const out = parseAliyunUsage({ DataV2: { data: { per2DayPercentage: '0.125', per2DayResetTime: Date.parse(RESET), per1MonthPercentage: 0 } } });
  assert.equal(out.windows[0].usedPercent, 12.5);
  assert.equal(out.windows[0].windowSeconds, 172800);
  assert.equal(out.windows[0].resetAt, RESET);
  assert.equal(out.windows[1].windowSeconds, undefined);
  for (const data of [{ success: false, data: { per1MonthPercentage: 0 } }, { DataV2: { failed: true, data: { per1MonthPercentage: 0 } } }, { ret: ['FAIL::secret'], data: { per1MonthPercentage: 0 } }]) assert.throws(() => parseAliyunUsage(data), { code: 'invalid-response' });
  assert.throws(() => parseAliyunUsage({ hasQuotaData: false, per1MonthPercentage: 0 }), { code: 'unavailable' });
});

test('Aliyun model keys cannot replace a Console credential', async () => {
  await assert.rejects(fetchOfficialUsage('aliyun-token-plan', { access: 'model-key', request: () => assert.fail('must not query') }), { code: 'billing-credential-required' });
});

test('Antigravity accepts documented wrappers and oneof fractions without onboarding or fabricated windows', () => {
  const out = parseAntigravityUsage({ response: { groups: [{ buckets: [{ id: 'week', remaining: { case: 'remainingFraction', value: 0.5 }, resetTime: RESET }, { id: 'disabled', remainingFraction: 1, disabled: true }, { id: 'unknown' }] }] } }, { projectId: 'p' });
  assert.equal(out.windows.length, 1);
  assert.equal(out.windows[0].usedPercent, 50);
  assert.equal(out.windows[0].resetAt, RESET);
  assert.equal(out.windows[0].scope, 'project:p');
  assert.equal(out.windows[0].windowSeconds, undefined);
});

test('Gemini fractions and independent AI credits do not conflate unknown bucket units', () => {
  const out = parseGeminiUsage({ ...fixtures['google-gemini-cli'], remainingCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '100' }] }, { projectId: 'p' });
  assert.ok(Math.abs(out.windows[0].usedPercent - 20) < 1e-10);
  assert.equal(out.windows[0].remaining, undefined);
  assert.equal(out.balances[0].amount, 100);
  assert.equal(out.balances[0].unit, 'credits');
});

test('Google missing project does not trigger a setup request; Antigravity supports empty summary context', async () => {
  await assert.rejects(fetchOfficialUsage('google-gemini-cli', { access: 'a', request: () => assert.fail('must not query') }), { code: 'scope-required' });
  await fetchOfficialUsage('google-antigravity', { access: 'a', request: async (url, options) => { assert.equal(options.body, '{}'); assert.match(options.headers['User-Agent'], /^antigravity\/hub\//); assert.equal(url.includes('onboard'), false); return fixtures['google-antigravity']; } });
});

test('Grok percentage, period and prepaid cents remain separate', () => {
  const out = parseXaiUsage(fixtures.xai);
  assert.equal(out.windows[0].usedPercent, 25);
  assert.equal(out.windows[0].windowSeconds, 30 * 86400);
  assert.equal(out.balances[0].amount, 12.34);
  assert.equal(out.balances[0].currency, 'USD');
  assert.equal(parseXaiUsage({ config: { prepaidBalance: {} } }).balances[0].amount, 0);
  assert.throws(() => parseXaiUsage({ config: {} }), { code: 'invalid-response' });
});

test('Nous basis points, milliseconds, rollover and credits are not summed twice', () => {
  const out = parseNousUsage(fixtures.nous);
  assert.equal(out.windows[0].usedPercent, 12.5);
  assert.equal(out.windows[0].resetAt, RESET);
  assert.equal(out.balances.find(x => x.id === 'nous:total').amount, 75);
  const rollover = parseNousUsage({ subscription: { plan: 'plus', monthly_credits: 100, credits_remaining: 150, rollover_credits: 50 } });
  assert.equal(rollover.windows.length, 0);
  assert.equal(rollover.balances.length, 2);
  assert.ok(rollover.notes[0].includes('overlap'));
});

test('regional endpoints do not depend on locale or an injected arbitrary base URL', async () => {
  for (const [id, host] of [['kimi-coding', 'api.kimi.com'], ['minimax', 'api.minimax.cn'], ['zai', 'bigmodel.cn'], ['aliyun-token-plan', 'bailian-cs.console.aliyun.com']]) {
    await fetchOfficialUsage(id, { region: 'cn', locale: 'en-US', baseURL: 'https://attacker.invalid', access: 'a', billingAccess: 'b', request: async (url) => { assert.equal(new URL(url).hostname, host); return fixtures[id]; } });
  }
});

test('numeric poison, invalid timestamps and arbitrary upstream messages stay out of output', () => {
  const out = parseCodexUsage({ rate_limit: { primary_window: { used_percent: true, reset_at: 1 }, secondary_window: { used_percent: 0, reset_at: 'not-a-date', limit_window_seconds: Infinity } } });
  assert.equal(out.windows.length, 1);
  assert.equal(out.windows[0].resetAt, undefined);
  assert.equal(out.windows[0].windowSeconds, undefined);
});

test('transport errors pass through unchanged and unknown IDs do not issue requests', async () => {
  const throttled = Object.assign(new Error('safe throttled message'), { code: 'rate-limited', retryAt: RESET });
  await assert.rejects(fetchOfficialUsage('openai-codex', { access: 'a', request: async () => { throw throttled; } }), error => error === throttled);
  await assert.rejects(fetchOfficialUsage('unknown', { request: () => assert.fail('must not query') }), { code: 'unsupported' });
});

test('Nous API inference key requires a separate Portal credential', async () => {
  await assert.rejects(fetchOfficialUsage('nous', { access: 'inference-key', rawGrant: { type: 'api_key', access: 'inference-key' }, request: () => assert.fail('must not send an inference key to Portal') }), { code: 'needs-permission' });
  await fetchOfficialUsage('nous', { access: 'inference-key', rawGrant: { type: 'api_key' }, billingAccess: 'portal-oauth', request: async (url, options) => { assert.equal(options.headers.Authorization, 'Bearer portal-oauth'); return fixtures.nous; } });
});

test('malformed optional array members cannot discard valid neighboring quota', () => {
  assert.ok(parseCodexUsage({ ...fixtures['openai-codex'], additional_rate_limits: [null] }).windows.length);
  assert.ok(parseClaudeUsage({ ...fixtures.anthropic, limits: [null] }).windows.length);
  assert.ok(parseGeminiUsage({ ...fixtures['google-gemini-cli'], remainingCredits: [null] }).windows.length);
  assert.ok(parseXaiUsage({ config: { ...fixtures.xai.config, productUsage: [null] } }).windows.length);
  assert.ok(parseNousUsage({ ...fixtures.nous, usage_window: { gauges: [null] } }).windows.length);
});
