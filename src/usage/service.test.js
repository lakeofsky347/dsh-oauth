import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageService, fetchUsage } from './index.js';
import { finite, iso, quotaWindow, balance, UsageError, createUsageRequest } from './core.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-usage-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const context = () => ({ access: 'test-secret', rawGrant: { access: 'test-secret' }, connection: { revision: 'one' } });
const sample = { windows: [{ id: 'daily', unit: 'requests', used: 5, limit: 10, remaining: 5 }], balances: [] };

test('unknown, zero, negative balance and explicit timestamp units remain distinct', () => {
  assert.equal(finite(null), undefined); assert.equal(finite(false), undefined); assert.equal(finite(''), undefined);
  assert.equal(finite('0'), 0); assert.equal(iso(1700000000, 'seconds'), '2023-11-14T22:13:20.000Z');
  assert.equal(iso('invalid'), undefined); assert.equal(balance({ amount: '-1.25', unit: 'money' }).amount, '-1.25');
  assert.deepEqual(quotaWindow({ used: 15, limit: 10 }), { used: 15, limit: 10, remaining: -5, usedPercent: 150, remainingPercent: -50 });
  assert.deepEqual(quotaWindow({ used: 0, limit: 0 }), { used: 0, limit: 0, remaining: 0 });
});

test('transport blocks redirects/unapproved hosts and redacts provider error text', async () => {
  let options;
  const request = createUsageRequest({ allowedHosts: ['api.example.test'], fetchImpl: async (_url, init) => { options = init; return new Response('test-secret', { status: 403 }); } });
  await assert.rejects(request('https://evil.test'), { code: 'needs-configuration' });
  await assert.rejects(request('https://api.example.test/usage'), error => error.code === 'needs-permission' && !error.message.includes('test-secret'));
  assert.equal(options.redirect, 'error');
});

test('persistent quota cache retains source timestamp, coalesces calls and contains no credential', async t => {
  const directory = await setup(t); let clock = 1700000000000; let calls = 0;
  const options = { directory, contextFor: context, now: () => clock, reader: async () => { calls++; return sample; } };
  const first = createUsageService(options);
  const results = await Promise.all([first.get('openrouter'), first.get('openrouter')]);
  assert.equal(calls, 1); assert.deepEqual(results[0], results[1]);
  const restarted = createUsageService(options);
  assert.deepEqual(await restarted.get('openrouter'), results[0]); assert.equal(calls, 1);
  assert.equal((await readFile(join(directory, 'dsh-oauth-usage.json'), 'utf8')).includes('test-secret'), false);
  clock += 61000;
  const unavailable = createUsageService({ ...options, reader: async () => { throw new UsageError('unavailable', 'offline'); } });
  const stale = await unavailable.get('openrouter');
  assert.equal(stale.status, 'stale'); assert.equal(stale.snapshot.observedAt, results[0].snapshot.observedAt);
});

test('account switch never displays previous account quota and permission loss hides stale figures', async t => {
  const directory = await setup(t); let current = context(); let clock = 1700000000000;
  const options = { directory, contextFor: () => current, now: () => clock, reader: async () => sample };
  await createUsageService(options).get('openrouter'); clock += 61000;
  const denied = createUsageService({ ...options, reader: async () => { throw new UsageError('needs-permission', 'forbidden'); } });
  assert.equal((await denied.get('openrouter')).snapshot, undefined);
  current = { ...current, rawGrant: { access: 'second-account' } };
  const switched = createUsageService({ ...options, reader: async () => { throw new UsageError('unavailable', 'offline'); } });
  assert.equal((await switched.get('openrouter')).status, 'unavailable');
  assert.equal((await switched.get('openrouter')).snapshot, undefined);
});

test('disconnect invalidates an in-flight query without reviving its persisted snapshot', async t => {
  const directory = await setup(t); let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const service = createUsageService({ directory, contextFor: context, reader: async () => { started(); await new Promise(resolve => { release = resolve; }); return sample; } });
  const pending = service.get('openrouter'); await entered; await service.invalidate('openrouter'); release();
  assert.equal((await pending).status, 'reauth-required');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'dsh-oauth-usage.json'), 'utf8')).entries, {});
});

test('429 retry-after survives restart and cannot be bypassed by force', async t => {
  const directory = await setup(t); let calls = 0; const now = 1700000000000;
  const options = { directory, contextFor: context, now: () => now, reader: async () => { calls++; throw new UsageError('rate-limited', 'limited', { retryAt: new Date(now + 120000).toISOString() }); } };
  assert.equal((await createUsageService(options).get('poe')).status, 'rate-limited');
  await createUsageService(options).get('poe', { force: true }); assert.equal(calls, 1);
});

test('provider-specific permission and scope failures normalize to documented UI states', async t => {
  const directory = await setup(t);
  for (const [id, code, status] of [['anthropic', 'scope-required', 'needs-permission'], ['google-gemini-cli', 'scope-required', 'needs-configuration'], ['aliyun-token-plan', 'billing-credential-required', 'needs-permission']]) {
    const service = createUsageService({ directory, contextFor: context, reader: async () => { throw new UsageError(code, 'additional authorization required'); } });
    assert.equal((await service.get(id)).status, status);
  }
});

test('DeepSeek API decimal balances and New API deployment units are preserved', async () => {
  const deepseek = await fetchUsage('deepseek', { access: 'test', request: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '0.00001' }] }) });
  assert.equal(deepseek.balances[0].amount, '0.00001');
  const gateway = await fetchUsage('new-api', { access: 'test', baseURL: 'https://gateway.example.test/v1', request: async (url) => { assert.equal(url, 'https://gateway.example.test/api/usage/token/'); return { success: true, data: { total_available: 5, total_used: 10, total_granted: 15 } }; } });
  assert.equal(gateway.windows[0].unit, 'quota'); assert.equal(gateway.windows[0].remaining, 5);
});
