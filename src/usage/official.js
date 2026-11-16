import { UsageError } from './core.js';

// Wire contracts are pinned in the external quota research reports (2026-11-16).
// These readers never refresh credentials, discover local files, onboard projects,
// or issue inference requests. The caller owns transport, identity and lifecycle.
export const officialUsageIds = Object.freeze([
  'openai-codex', 'anthropic', 'github-copilot', 'kimi-coding', 'minimax',
  'zai', 'aliyun-token-plan', 'google-antigravity', 'google-gemini-cli', 'xai', 'nous',
]);

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value.slice(0, 200) : [];
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
function number(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))) return undefined;
  const result = Number(value);
  return Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER ? result : undefined;
}
const positive = value => { const n = number(value); return n !== undefined && n >= 0 ? n : undefined; };
function label(value) {
  return typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) : undefined;
}
function date(value, unit = 'iso') {
  let time;
  if (unit === 'iso') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return undefined;
    time = Date.parse(value);
  } else { const n = number(value); if (n !== undefined) time = n * (unit === 'seconds' ? 1000 : 1); }
  return Number.isFinite(time) && time > 0 && time <= 8.64e15 ? new Date(time).toISOString() : undefined;
}
function percentage(id, title, used, extra = {}) {
  used = positive(used);
  return used === undefined ? undefined : compact({ id, label: title, unit: 'percent', usedPercent: used, remainingPercent: 100 - used, ...extra });
}
function counts(id, title, unit, used, limit, remaining, extra = {}) {
  used = positive(used); limit = positive(limit); remaining = number(remaining);
  if (used === undefined && remaining !== undefined && limit !== undefined && remaining <= limit) used = limit - remaining;
  if (remaining === undefined && used !== undefined && limit !== undefined) remaining = limit - used;
  if (used === undefined && remaining === undefined && !extra.unlimited) return undefined;
  return compact({ id, label: title, unit, used, limit, remaining, ...extra });
}
function wallet(id, title, amount, unit = 'money', currency) {
  amount = number(amount);
  return amount === undefined ? undefined : compact({ id, label: title, amount, unit, currency });
}
function plan(name, id = name) { name = label(name); id = label(id); return name || id ? compact({ name, id }) : undefined; }
function result(windows = [], balances = [], extra = {}) {
  windows = windows.filter(Boolean); balances = balances.filter(Boolean);
  if (!windows.length && !balances.length && !extra.plan) throw new UsageError('invalid-response', 'The provider returned no recognized usage data.');
  return compact({ windows, balances, ...extra, status: windows.length || balances.length ? (extra.status ?? 'fresh') : 'partial' });
}
function requireRecord(data) { if (!record(data)) throw new UsageError('invalid-response', 'The provider usage response is invalid.'); return data; }
function token(value, code = 'credential-required') {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new UsageError(code, 'The required usage credential is unavailable.');
  return value;
}
const bearer = access => ({ Authorization: `Bearer ${token(access)}`, Accept: 'application/json' });
const scope = ctx => [ctx.organizationId && `organization:${label(ctx.organizationId)}`, ctx.projectId && `project:${label(ctx.projectId)}`, ctx.workspaceId && `workspace:${label(ctx.workspaceId)}`].filter(Boolean).join('/') || 'account';

export function parseCodexUsage(data, ctx = {}) {
  requireRecord(data);
  const windows = [];
  const read = (rate, prefix = 'codex', title = 'Codex') => {
    if (!record(rate)) return;
    for (const [key, name] of [['primary_window', 'Primary'], ['secondary_window', 'Secondary']]) {
      const row = rate[key]; if (!record(row)) continue;
      const delay = positive(row.reset_after_seconds);
      const resetAt = date(row.reset_at, 'seconds') ?? (delay !== undefined && number(ctx.now) !== undefined ? date(ctx.now + delay * 1000, 'milliseconds') : undefined);
      windows.push(percentage(`${prefix}:${key}`, `${title} ${name}`, row.used_percent, { resetAt, windowSeconds: positive(row.limit_window_seconds), scope: 'account' }));
    }
  };
  read(data.rate_limit);
  for (const [i, row] of array(data.additional_rate_limits).entries()) if (record(row)) read(row.rate_limit, `codex:additional:${i}`, label(row.limit_name) ?? label(row.metered_feature) ?? 'Additional allowance');
  const balances = [];
  if (record(data.credits)) {
    balances.push(wallet('codex:credits', 'Codex credits', data.credits.balance, 'credits'));
    if (data.credits.unlimited === true) windows.push({ id: 'codex:credits-unlimited', label: 'Codex credits', unit: 'credits', unlimited: true, scope: 'account' });
  }
  const control = data.spend_control?.individual_limit;
  if (record(control)) windows.push(counts('codex:spend-control', 'Individual spending limit', 'credits', control.used, control.limit, control.remaining, { resetAt: date(control.reset_at, 'seconds'), scope: 'individual' }));
  return result(windows, balances, { plan: plan(data.plan_type), notes: data.rate_limit?.limit_reached === true ? ['The provider reports an exhausted allowance.'] : undefined });
}

export function parseClaudeUsage(data) {
  requireRecord(data);
  const windows = [];
  for (const [id, title, duration] of [['five_hour', 'Five-hour allowance', 18000], ['seven_day', 'Weekly allowance', 604800], ['seven_day_sonnet', 'Sonnet weekly allowance', 604800], ['seven_day_opus', 'Opus weekly allowance', 604800], ['seven_day_oauth_apps', 'OAuth apps weekly allowance', 604800]]) {
    const row = data[id]; if (!record(row)) continue;
    // The generic weekly field supersedes its OAuth-app fallback, not model-specific buckets.
    if (id === 'seven_day_oauth_apps' && record(data.seven_day)) continue;
    windows.push(percentage(id, title, row.utilization, { resetAt: date(row.resets_at), windowSeconds: duration, scope: id.includes('sonnet') ? 'model:sonnet' : id.includes('opus') ? 'model:opus' : 'account' }));
  }
  for (const [i, row] of array(data.limits).entries()) if (record(row)) windows.push(percentage(`claude:limit:${i}`, label(row.scope?.model?.display_name) ?? 'Model allowance', row.utilization, { resetAt: date(row.resets_at), scope: label(row.scope?.model?.id) }));
  const extra = data.extra_usage;
  const balances = [];
  if (record(extra) && extra.is_enabled === true) {
    const used = positive(extra.used_credits), limit = positive(extra.monthly_limit);
    windows.push(counts('claude:extra-usage', 'Extra usage spending cap', 'money', used === undefined ? undefined : used / 100, limit === undefined ? undefined : limit / 100, undefined, { scope: 'extra-usage' }));
    if (used !== undefined && limit !== undefined) balances.push(wallet('claude:extra-remaining', 'Extra usage budget remaining', (limit - used) / 100, 'money', /^[A-Z]{3}$/.test(extra.currency ?? '') ? extra.currency : undefined));
  }
  return result(windows, balances, { notes: record(extra) && extra.is_enabled === true && !extra.currency ? ['Extra usage amounts are converted from cents; the response did not identify a currency.'] : undefined });
}

export function parseCopilotUsage(data) {
  requireRecord(data);
  const windows = [], seen = new Set();
  const resetAt = date(data.quota_reset_date ?? data.quota_reset_date_utc);
  const isCredits = data.token_based_billing === true;
  for (const [id, row] of Object.entries(record(data.quota_snapshots) ? data.quota_snapshots : {}).slice(0, 200)) {
    if (!record(row)) continue;
    const pool = label(row.quota_id); if (pool && seen.has(pool)) continue;
    if (pool) seen.add(pool);
    const unit = isCredits ? 'credits' : 'requests';
    if (row.unlimited === true) { windows.push({ id: `copilot:${id}`, label: label(id) ?? 'Copilot', unit, unlimited: true, scope: 'account' }); continue; }
    const limit = positive(row.entitlement), remaining = positive(row.remaining), used = positive(row.credits_used);
    if (limit === 0 && remaining === 0) {
      if (used !== undefined) windows.push(counts(`copilot:${id}`, label(id) ?? 'Copilot credits', 'credits', used, undefined, undefined, { scope: 'account', resetAt }));
      continue;
    }
    const rowWindow = counts(`copilot:${id}`, label(id) ?? 'Copilot', unit, isCredits ? used : undefined, limit, remaining, { scope: 'account', resetAt });
    const rp = positive(row.percent_remaining);
    if (rowWindow) windows.push({ ...rowWindow, ...(rp !== undefined && rp <= 100 ? { remainingPercent: rp, usedPercent: 100 - rp } : {}) });
    else if (rp !== undefined && rp <= 100) windows.push(percentage(`copilot:${id}`, label(id) ?? 'Copilot', 100 - rp, { scope: 'account', resetAt }));
  }
  return result(windows, [], { plan: plan(data.copilot_plan), notes: isCredits ? ['Copilot reports AI-credit billing; this is not a premium-request count.'] : undefined });
}

export function parseKimiUsage(data) {
  requireRecord(data);
  const windows = [];
  for (const [id, title, duration] of [['limit_5h', 'Five-hour allowance', 18000], ['limit_7d', 'Weekly allowance', 604800], ['limit_month_total', 'Monthly total allowance'], ['limit_month_code', 'Monthly coding allowance']]) {
    const row = data.usages?.[id]; if (!record(row)) continue;
    const ratio = positive(row.used_ratio);
    windows.push(percentage(id, title, ratio === undefined ? undefined : ratio * 100, { resetAt: date(row.reset_time), windowSeconds: duration, scope: id === 'limit_month_code' ? 'coding' : 'account' }));
  }
  const balances = [], extra = data.boosterWallet;
  if (record(extra) && extra.balance?.type === 'BOOSTER') {
    const currency = label(extra.monthlyChargeLimit?.currency) ?? label(extra.monthlyUsed?.currency);
    const remaining = number(extra.balance.amountLeft), total = number(extra.balance.amount);
    // The wire amount is 1,000,000 fixed-point units per cent, i.e. 100,000,000 per currency unit.
    balances.push(wallet('kimi:booster', 'Extra usage wallet', remaining === undefined ? undefined : remaining / 100_000_000, 'money', currency));
    if (total !== undefined && remaining !== undefined) windows.push(counts('kimi:booster-budget', 'Extra usage wallet allocation', 'money', undefined, total / 100_000_000, remaining / 100_000_000, { scope: 'booster' }));
    if (extra.monthlyChargeLimitEnabled === true) {
      const used = positive(extra.monthlyUsed?.priceInCents), limit = positive(extra.monthlyChargeLimit?.priceInCents);
      windows.push(counts('kimi:extra-monthly', 'Extra usage monthly cap', 'money', used === undefined ? undefined : used / 100, limit === undefined ? undefined : limit / 100, undefined, { scope: 'booster' }));
    }
  }
  return result(windows, balances);
}

export function resolveMiniMaxCounts(reported, total, remainingPercent) {
  reported = positive(reported); total = positive(total); remainingPercent = positive(remainingPercent);
  if (reported === undefined || !total || reported > total) return undefined;
  let remaining = reported;
  if (remainingPercent !== undefined) {
    const asRemaining = Math.abs(reported / total * 100 - remainingPercent);
    const asUsed = Math.abs((total - reported) / total * 100 - remainingPercent);
    if (Math.min(asRemaining, asUsed) > 1) return undefined;
    if (asUsed < asRemaining) remaining = total - reported;
  }
  return { used: total - remaining, limit: total, remaining };
}

export function parseMiniMaxUsage(data, ctx = {}) {
  requireRecord(data);
  if (data.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0) throw new UsageError('invalid-response', 'MiniMax could not return subscription usage.');
  const windows = [], notes = [];
  for (const [i, row] of array(data.model_remains).entries()) {
    if (!record(row)) continue;
    if (number(row.current_interval_total_count) === 0 && number(row.current_weekly_total_count) === 0 && number(row.current_interval_status) === 3 && number(row.current_weekly_status) === 3) { notes.push('A service not included in this plan was omitted.'); continue; }
    for (const [kind, startKey, endKey, remainingKey] of [['interval', 'start_time', 'end_time', 'remains_time'], ['weekly', 'weekly_start_time', 'weekly_end_time', 'weekly_remains_time']]) {
      const id = `minimax:${i}:${kind}`, title = `${label(row.model_name) ?? 'Service'} ${kind}`;
      const start = positive(row[startKey]), end = positive(row[endKey]), wait = positive(row[remainingKey]);
      const extra = compact({ scope: label(row.model_name), resetAt: date(end, 'milliseconds') ?? (wait !== undefined && number(ctx.now) !== undefined ? date(ctx.now + wait, 'milliseconds') : undefined), windowSeconds: start !== undefined && end !== undefined && end > start ? (end - start) / 1000 : undefined });
      if (number(row[`current_${kind}_status`]) === 3) { windows.push({ id, label: title, unit: 'requests', unlimited: true, ...extra }); continue; }
      const rp = positive(row[`current_${kind}_remaining_percent`]);
      const values = resolveMiniMaxCounts(row[`current_${kind}_usage_count`], row[`current_${kind}_total_count`], rp);
      if (values) windows.push({ id, label: title, unit: 'requests', ...values, ...(rp !== undefined ? { remainingPercent: rp, usedPercent: 100 - rp } : {}), ...extra });
      else if (rp !== undefined && rp <= 100) windows.push(percentage(id, title, 100 - rp, extra));
      if (values && rp === undefined) notes.push('MiniMax legacy counters are interpreted as remaining counts.');
    }
    const boost = positive(row.weekly_boost_permille);
    if (boost !== undefined && boost !== 1000) notes.push(`Weekly allowance multiplier: ${boost / 1000}. Percentages retain the provider's base allowance.`);
  }
  return result(windows, [], { notes: notes.length ? [...new Set(notes)] : undefined });
}

export function parseZaiUsage(data, ctx = {}) {
  requireRecord(data);
  if (data.success === false || (data.code !== undefined && data.code !== 200)) throw new UsageError('invalid-response', 'The Coding Plan usage request was not successful.');
  const windows = [];
  for (const [i, row] of array(data.data?.limits).entries()) {
    if (!record(row) || !['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(row.type)) continue;
    const duration = row.unit === 3 ? 3600 : row.unit === 6 ? 604800 : undefined;
    const n = positive(row.number);
    const extra = { scope: scope(ctx), resetAt: date(row.nextResetTime, 'milliseconds'), windowSeconds: duration && n ? duration * n : undefined };
    const title = row.type === 'TIME_LIMIT' ? 'Tool allowance' : 'Coding Plan allowance';
    if (row.type === 'TIME_LIMIT') {
      const w = counts(`zai:${i}`, title, 'requests', row.currentValue, row.usage, row.remaining, extra);
      windows.push(w ?? percentage(`zai:${i}`, title, row.percentage, extra));
    } else windows.push(percentage(`zai:${i}`, title, row.percentage, extra));
  }
  return result(windows, [], { plan: plan(data.data?.level) });
}

export function parseAliyunUsage(data) {
  requireRecord(data);
  let body = data;
  // Console gateway envelopes are bounded; never recursively search arbitrary documents.
  for (let i = 0; i < 7; i++) {
    const badCode = body.success !== true && body.successResponse !== true && body.errorCode !== undefined && !['0', '200'].includes(String(body.errorCode));
    if (body.success === false || body.successResponse === false || body.failed === true || badCode || array(body.ret).some(value => typeof value === 'string' && !value.startsWith('SUCCESS::'))) throw new UsageError('invalid-response', 'The Console did not return Token Plan usage.');
    if (Object.keys(body).some(key => /^per\d+(Hour|Day|Week|Month)Percentage$/.test(key)) || body.hasQuotaData === false) break;
    const nested = Object.hasOwn(body, 'DataV2') ? body.DataV2 : body.data;
    if (!record(nested)) break;
    body = nested;
  }
  if (body.hasQuotaData === false) throw new UsageError('unavailable', 'The Console has no quota data for this account.');
  const windows = [];
  for (const [key, value] of Object.entries(body)) {
    const m = /^per(\d+)(Hour|Day|Week|Month)Percentage$/.exec(key); if (!m) continue;
    const ratio = positive(value); if (ratio === undefined) continue;
    const prefix = `per${m[1]}${m[2]}`;
    const seconds = { Hour: 3600, Day: 86400, Week: 604800 }[m[2]];
    windows.push(percentage(prefix, `${m[1]} ${m[2]} allowance`, ratio * 100, { resetAt: date(body[`${prefix}ResetTime`], 'milliseconds'), windowSeconds: seconds ? Number(m[1]) * seconds : undefined, scope: 'personal-token-plan' }));
  }
  return result(windows);
}

export function parseAntigravityUsage(data, ctx = {}) {
  requireRecord(data);
  const body = record(data.response) ? data.response : record(data.summary) ? data.summary : data;
  const windows = [];
  for (const [gi, group] of array(body.groups).entries()) for (const [bi, row] of array(group?.buckets).entries()) {
    if (!record(row) || row.disabled === true) continue;
    const fraction = positive(row.remainingFraction ?? row.remaining?.remainingFraction ?? (row.remaining?.case === 'remainingFraction' ? row.remaining.value : undefined));
    if (fraction === undefined || fraction > 1) continue;
    const id = label(row.bucketId ?? row.id); if (!id) continue;
    windows.push(percentage(`antigravity:${gi}:${bi}:${id}`, [label(group.displayName ?? group.name), label(row.displayName ?? row.name) ?? id].filter(Boolean).join(' / '), (1 - fraction) * 100, { resetAt: date(row.resetTime), scope: scope(ctx) }));
  }
  return result(windows, [], { notes: ['Read-only remote quota summary; no project onboarding is performed.'] });
}

export function parseGeminiUsage(data, ctx = {}) {
  requireRecord(data);
  const windows = [];
  for (const [i, row] of array(data.buckets).entries()) {
    if (!record(row)) continue;
    const fraction = positive(row.remainingFraction); if (fraction === undefined || fraction > 1) continue;
    windows.push(percentage(`gemini:${i}`, label(row.modelId) ?? 'Code Assist allowance', (1 - fraction) * 100, { resetAt: date(row.resetTime), scope: `${scope(ctx)}${label(row.tokenType) ? `/${label(row.tokenType)}` : ''}` }));
    // remainingAmount is deliberately not called tokens or requests: tokenType is not a stable unit contract.
  }
  const balances = [];
  for (const [i, row] of array(data.remainingCredits).entries()) if (record(row)) balances.push(wallet(`gemini:credits:${i}`, label(row.creditType) ?? 'AI credits', row.creditAmount, 'credits'));
  return result(windows, balances);
}

export function parseXaiUsage(data) {
  requireRecord(data); const config = requireRecord(data.config);
  const end = date(config.currentPeriod?.end) ?? date(config.billingPeriodEnd);
  const start = date(config.currentPeriod?.end) ? date(config.currentPeriod?.start) : date(config.billingPeriodStart);
  const extra = { resetAt: end, windowSeconds: start && end && Date.parse(end) > Date.parse(start) ? (Date.parse(end) - Date.parse(start)) / 1000 : undefined, scope: 'account' };
  const windows = [percentage('xai:included', 'Included allowance', config.creditUsagePercent, extra)];
  for (const [i, row] of array(config.productUsage).entries()) if (record(row)) windows.push(percentage(`xai:product:${i}`, label(row.product) ?? 'Product usage', row.usagePercent, { ...extra, scope: `product:${label(row.product) ?? i}` }));
  let cents = number(config.prepaidBalance?.val);
  // Proto3's present empty Cent object explicitly encodes zero, unlike an absent wallet.
  if (record(config.prepaidBalance) && !Object.keys(config.prepaidBalance).length) cents = 0;
  return result(windows, [wallet('xai:prepaid', 'Prepaid balance', cents === undefined ? undefined : cents / 100, 'money', 'USD')], { plan: plan(config.subscriptionTier ?? data.subscriptionTier) });
}

export function parseNousUsage(data) {
  requireRecord(data);
  const windows = [], balances = [];
  for (const [i, row] of array(data.usage_window?.gauges).entries()) {
    if (!record(row)) continue;
    const bp = positive(row.used_bp); if (bp === undefined) continue;
    windows.push(percentage(`nous:${label(row.id) ?? i}`, label(row.label) ?? 'Subscription allowance', bp / 100, { resetAt: date(row.resets_at_ms, 'milliseconds'), scope: label(row.scope) }));
  }
  const subscription = data.subscription, access = data.paid_service_access;
  if (record(subscription)) {
    const cap = positive(subscription.monthly_credits), remaining = positive(subscription.credits_remaining);
    balances.push(wallet('nous:subscription', 'Subscription credits', access?.subscription_credits_remaining ?? remaining, 'money', 'USD'));
    balances.push(wallet('nous:rollover', 'Rollover credits', subscription.rollover_credits, 'money', 'USD'));
    if (cap && remaining !== undefined && remaining <= cap) windows.push(counts('nous:monthly-credits', 'Monthly subscription credits', 'money', undefined, cap, remaining, { resetAt: date(subscription.current_period_end), scope: 'subscription' }));
  }
  if (record(access)) {
    balances.push(wallet('nous:purchased', 'Purchased credits', access.purchased_credits_remaining, 'money', 'USD'));
    balances.push(wallet('nous:total', 'Total usable credits', access.total_usable_credits, 'money', 'USD'));
  }
  return result(windows, balances, { plan: plan(subscription?.plan), notes: ['Total usable credits overlap the component balances; do not add them together.'] });
}

export async function fetchOfficialUsage(id, ctx) {
  if (!officialUsageIds.includes(id)) throw new UsageError('unsupported', 'This provider has no official usage adapter.');
  if (!ctx || typeof ctx.request !== 'function') throw new UsageError('unavailable', 'Usage transport is unavailable.');
  const request = ctx.request;
  switch (id) {
    case 'openai-codex': {
      const accountId = label(ctx.rawGrant?.accountId ?? ctx.rawGrant?.account_id);
      return parseCodexUsage(await request('https://chatgpt.com/backend-api/wham/usage', { headers: { ...bearer(ctx.access), ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}) } }), ctx);
    }
    case 'anthropic': {
      const rawScopes = ctx.rawGrant?.scope ?? ctx.rawGrant?.scopes;
      const scopes = typeof rawScopes === 'string' ? rawScopes.split(/\s+/) : rawScopes;
      if (Array.isArray(scopes) && !scopes.includes('user:profile')) throw new UsageError('scope-required', 'Claude usage requires the user:profile scope.');
      return parseClaudeUsage(await request('https://api.anthropic.com/api/oauth/usage', { headers: { ...bearer(ctx.access), 'anthropic-beta': 'oauth-2025-04-20' } }));
    }
    case 'github-copilot':
      return parseCopilotUsage(await request('https://api.github.com/copilot_internal/user', { headers: { Authorization: `token ${token(ctx.rawGrant?.access, 'source-credential-required')}`, Accept: 'application/json', 'Editor-Version': 'vscode/1.96.2', 'Editor-Plugin-Version': 'copilot-chat/0.26.7', 'User-Agent': 'GitHubCopilotChat/0.26.7', 'X-Github-Api-Version': '2025-04-01' } }));
    case 'kimi-coding':
      return parseKimiUsage(await request(`https://${ctx.region === 'cn' ? 'api.kimi.com' : 'api.kimi.ai'}/coding/v1/usages`, { headers: bearer(ctx.access) }));
    case 'minimax':
      return parseMiniMaxUsage(await request(`https://${ctx.region === 'cn' ? 'api.minimax.cn' : 'api.minimax.io'}/v1/token_plan/remains`, { headers: bearer(ctx.access) }), ctx);
    case 'zai': {
      const team = Boolean(ctx.organizationId || ctx.projectId);
      if (team && (!ctx.organizationId || !ctx.projectId)) throw new UsageError('scope-required', 'Team usage requires both organization and project.');
      const headers = { authorization: token(ctx.access), Accept: 'application/json', ...(team ? { 'bigmodel-organization': token(ctx.organizationId), 'bigmodel-project': token(ctx.projectId) } : {}) };
      return parseZaiUsage(await request(`https://${ctx.region === 'cn' ? 'bigmodel.cn' : 'api.z.ai'}/api/monitor/usage/quota/limit${team ? '?type=2' : ''}`, { headers }), ctx);
    }
    case 'aliyun-token-plan': {
      const access = token(ctx.billingAccess, 'billing-credential-required');
      const cn = ctx.region === 'cn', region = cn ? 'cn-beijing' : 'ap-southeast-1';
      const api = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';
      const params = { Api: api, V: '1.0', Data: { cornerstoneParam: { protocol: 'V2', console: 'ONE_CONSOLE', productCode: 'p_efm', switchUserType: 3, consoleSite: 'BAILIAN_ALIYUN' } } };
      const body = new URLSearchParams({ params: JSON.stringify(params), region }).toString();
      return parseAliyunUsage(await request(`https://${cn ? 'bailian-cs.console.aliyun.com' : 'bailian-singapore-cs.alibabacloud.com'}/cli/api.json?action=${cn ? 'BroadScopeAspnGateway' : 'IntlBroadScopeAspnGateway'}&product=sfm_bailian&api=${encodeURIComponent(api)}`, { method: 'POST', headers: { ...bearer(access), 'Content-Type': 'application/x-www-form-urlencoded' }, body }));
    }
    case 'google-antigravity':
      return parseAntigravityUsage(await request('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', { method: 'POST', headers: { ...bearer(ctx.access), 'Content-Type': 'application/json', 'User-Agent': `antigravity/hub/2.9.1 ${process.platform === 'linux' ? 'linux' : 'darwin'}/${process.arch === 'arm64' ? 'arm64' : 'amd64'}` }, body: JSON.stringify(ctx.projectId ? { project: token(ctx.projectId) } : {}) }), ctx);
    case 'google-gemini-cli': {
      if (!ctx.projectId) throw new UsageError('scope-required', 'Code Assist usage requires its authorized project.');
      return parseGeminiUsage(await request('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', { method: 'POST', headers: { ...bearer(ctx.access), 'Content-Type': 'application/json' }, body: JSON.stringify({ project: token(ctx.projectId) }) }), ctx);
    }
    case 'xai':
      return parseXaiUsage(await request('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers: { ...bearer(ctx.access), 'x-xai-token-auth': 'xai-grok-cli' } }));
    case 'nous':
      return parseNousUsage(await request('https://portal.nousresearch.com/api/oauth/account', { headers: bearer(ctx.rawGrant?.type === 'api_key' ? token(ctx.billingAccess, 'needs-permission') : ctx.access) }));
  }
}
