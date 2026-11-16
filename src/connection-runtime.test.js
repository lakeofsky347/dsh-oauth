import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionRuntime } from './connection-runtime.js';
import { nativeKey, connectionKey, connectionRef } from './connections.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
function memoryCredentials() {
  const records = new Map(), references = new Map();
  let queue = Promise.resolve();
  return {
    records, references,
    async readRecord(key) { return clone(records.get(key)); },
    async modifyRecord(key, mutate) {
      const pending = queue.then(async () => {
        const next = await mutate(clone(records.get(key)));
        if (next !== undefined) records.set(key, clone(next));
        return clone(records.get(key));
      });
      queue = pending.catch(() => {}); return pending;
    },
    async deleteRecord(key) { records.delete(key); },
    async set(key, value) { references.set(key, value); },
    async unset(key) { references.delete(key); },
  };
}
const unavailableNative = () => assert.fail('A managed connection must not invoke native OAuth refresh');

test('key connection resolves selected access and regional metadata without pi OAuth', async () => {
  const credentials = memoryCredentials();
  const runtime = createConnectionRuntime(credentials, unavailableNative);
  await runtime.connections.connect('minimax', { access: 'fixture-key', region: 'cn', billingAccess: 'fixture-billing' });
  const grant = await runtime.resolve('minimax');
  assert.equal(grant.type, 'api_key');
  assert.equal(grant.access, 'fixture-key');
  assert.equal(grant.region, 'cn');
  assert.equal(credentials.references.get(connectionRef('minimax')), 'fixture-key');
  const context = await runtime.contextFor('minimax');
  assert.equal(context.billingAccess, 'fixture-billing');
  assert.equal(context.rawGrant.access, 'fixture-key');
  assert.equal(context.region, 'cn');
});

test('native account preserves separate request auth and source grant for Copilot quota', async () => {
  const credentials = memoryCredentials();
  credentials.records.set(nativeKey('github-copilot'), { kind: 'grant', payload: { type: 'oauth', access: 'github-long-token', refresh: 'owner-refresh', expires: 0 } });
  let calls = 0;
  const runtime = createConnectionRuntime(credentials, async (id, options) => {
    calls += 1; assert.equal(id, 'github-copilot');
    return { type: 'oauth', access: 'copilot-inference-token', apiBase: 'https://api.githubcopilot.com' };
  });
  const context = await runtime.contextFor('github-copilot');
  assert.equal(calls, 1);
  assert.equal(context.access, 'copilot-inference-token');
  assert.equal(context.rawGrant.access, 'github-long-token');
});

test('native grant recovery options pass through unchanged', async () => {
  const credentials = memoryCredentials(), options = { rejectedGrant: { access: 'old' } };
  const runtime = createConnectionRuntime(credentials, async (id, actual) => { assert.equal(actual, options); return { access: 'new' }; });
  assert.equal((await runtime.resolve('xai', options)).access, 'new');
});

test('external OAuth rereads source and mirrors access only without native refresh', async () => {
  const credentials = memoryCredentials(); let access = 'source-a', reads = 0;
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async (source, provider) => {
    reads += 1; assert.equal(source, 'opencode'); assert.equal(provider, 'fixture-provider');
    return { provider, owner: 'external-managed', grant: { type: 'oauth', access, expires: Date.now() + 3600000 } };
  } });
  await runtime.connections.saveLocal('fixture-provider', 'opencode', 'OpenCode CLI');
  assert.equal((await runtime.resolve('fixture-provider')).access, 'source-a');
  access = 'source-b';
  assert.equal((await runtime.resolve('fixture-provider')).access, 'source-b');
  assert.equal(reads, 2);
  assert.equal(credentials.records.get(nativeKey('fixture-provider')).payload.access, 'source-b');
  assert.equal(credentials.records.get(nativeKey('fixture-provider')).payload.refresh, undefined);
});

test('external API key updates permanent reference and does not create native OAuth', async () => {
  const credentials = memoryCredentials(); let access = 'source-key-a';
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => ({ grant: { type: 'api_key', access } }) });
  await runtime.connections.saveLocal('openrouter', 'opencode', 'OpenCode CLI');
  assert.equal(await runtime.customRoute('openrouter'), true);
  await runtime.resolve('openrouter');
  access = 'source-key-b'; await runtime.resolve('openrouter');
  assert.equal(credentials.references.get(connectionRef('openrouter')), 'source-key-b');
  assert.equal(credentials.records.has(nativeKey('openrouter')), false);
});

test('local source errors are transparent and never fall back to native or another source', async () => {
  const credentials = memoryCredentials();
  const sourceError = Object.assign(new Error('Renew the source CLI'), { code: 'source-reauth-required' });
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => { throw sourceError; } });
  await runtime.connections.saveLocal('fixture-provider', 'opencode', 'OpenCode CLI');
  await assert.rejects(runtime.resolve('fixture-provider'), error => error === sourceError);
});

test('key preflight reconstructs a missing reference from the selected durable connection', async () => {
  const credentials = memoryCredentials();
  const runtime = createConnectionRuntime(credentials, unavailableNative);
  await runtime.connections.connect('minimax', { access: 'durable-key' });
  credentials.references.delete(connectionRef('minimax'));
  await runtime.resolve('minimax');
  assert.equal(credentials.references.get(connectionRef('minimax')), 'durable-key');
});

test('contextFor obtains one coherent external credential snapshot', async () => {
  const credentials = memoryCredentials(); let reads = 0;
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => ({ grant: { type: 'oauth', access: ++reads === 1 ? 'account-a' : 'account-b' } }) });
  await runtime.connections.saveLocal('fixture-provider', 'opencode', 'OpenCode CLI');
  const context = await runtime.contextFor('fixture-provider');
  assert.equal(context.access, context.rawGrant.access, 'request token and account fingerprint must describe the same source snapshot');
  assert.equal(reads, 1, 'a single usage context must not read a mutable source twice');
});

test('expired external source invalidates its previous host OAuth mirror', async () => {
  const credentials = memoryCredentials(); let available = true;
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => {
    if (!available) throw Object.assign(new Error('Renew source CLI'), { code: 'source-reauth-required' });
    return { grant: { type: 'oauth', access: 'old-source-token' } };
  } });
  await runtime.connections.saveLocal('fixture-provider', 'opencode', 'OpenCode CLI');
  await runtime.resolve('fixture-provider'); available = false;
  await assert.rejects(runtime.resolve('fixture-provider'), { code: 'source-reauth-required' });
  assert.equal(credentials.records.get(nativeKey('fixture-provider'))?.payload.access, '');
  assert.equal(credentials.records.get(nativeKey('fixture-provider'))?.payload.revoked, true);
});

test('deleted external source invalidates its previous API-key reference', async () => {
  const credentials = memoryCredentials(); let available = true;
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => {
    if (!available) throw Object.assign(new Error('Source missing'), { code: 'source-unavailable' });
    return { grant: { type: 'api_key', access: 'old-source-key' } };
  } });
  await runtime.connections.saveLocal('openrouter', 'opencode', 'OpenCode CLI');
  await runtime.resolve('openrouter'); available = false;
  await assert.rejects(runtime.resolve('openrouter'), { code: 'source-unavailable' });
  assert.equal(credentials.references.get(connectionRef('openrouter')), undefined);
});

test('a source read completing after disconnect cannot recreate an OAuth mirror', async () => {
  const credentials = memoryCredentials(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => { entered(); await gate; return { grant: { type: 'oauth', access: 'late-source' } }; } });
  await runtime.connections.saveLocal('fixture-provider', 'opencode', 'OpenCode CLI');
  const pending = runtime.resolve('fixture-provider'); await started;
  await runtime.connections.disconnect('fixture-provider');
  release();
  await assert.rejects(pending);
  assert.equal(credentials.records.get(nativeKey('fixture-provider')), undefined);
  assert.equal(credentials.records.get(connectionKey('fixture-provider')), undefined);
});

test('a late source snapshot cannot overwrite a newer completed mirror of the same connection', async () => {
  const credentials = memoryCredentials(); let release, entered, calls = 0;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => {
    if (++calls === 1) { entered(); await gate; return { grant: { type: 'oauth', access: 'older' } }; }
    return { grant: { type: 'oauth', access: 'newer' } };
  } });
  await runtime.connections.saveLocal('fixture-provider', 'opencode', 'OpenCode CLI');
  const old = runtime.resolve('fixture-provider'); await started;
  assert.equal((await runtime.resolve('fixture-provider')).access, 'newer');
  release(); await assert.rejects(old, { code: 'connection-changed' });
  assert.equal(credentials.records.get(nativeKey('fixture-provider')).payload.access, 'newer');
});

test('an older failed source read cannot revoke a newer successful source mirror', async () => {
  const credentials = memoryCredentials(); let fail, entered, calls = 0;
  const gate = new Promise((resolve, reject) => { fail = reject; }), started = new Promise(resolve => { entered = resolve; });
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => {
    if (++calls === 1) { entered(); await gate; }
    return { grant: { type: 'oauth', access: 'newer' } };
  } });
  await runtime.connections.saveLocal('fixture-provider', 'opencode', 'OpenCode CLI');
  const old = runtime.resolve('fixture-provider'); await started;
  await runtime.resolve('fixture-provider');
  fail(Object.assign(new Error('source temporarily missing'), { code: 'source-unavailable' }));
  await assert.rejects(old, { code: 'source-unavailable' });
  assert.equal(credentials.records.get(nativeKey('fixture-provider')).payload.access, 'newer');
});

test('failed external source never clears a newer native login', async () => {
  const credentials = memoryCredentials(); let available = true;
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => {
    if (!available) throw new Error('source unavailable');
    return { grant: { type: 'oauth', access: 'source-token' } };
  } });
  await runtime.connections.saveLocal('fixture-provider', 'opencode', 'OpenCode CLI'); await runtime.resolve('fixture-provider');
  const native = { kind: 'grant', payload: { type: 'oauth', access: 'new-native', refresh: 'owned-native-refresh' } };
  credentials.records.set(nativeKey('fixture-provider'), native); available = false;
  await assert.rejects(runtime.resolve('fixture-provider'));
  assert.deepEqual(credentials.records.get(nativeKey('fixture-provider')), native);
});

test('external mirror strips a refresh field even from an injected source implementation', async () => {
  const credentials = memoryCredentials();
  const runtime = createConnectionRuntime(credentials, unavailableNative, { localRead: async () => ({ grant: { type: 'oauth', access: 'source', refresh: 'must-not-enter-host', arbitrary: 'not-forwarded' } }) });
  await runtime.connections.saveLocal('fixture-provider', 'opencode', 'OpenCode CLI');
  const grant = await runtime.resolve('fixture-provider');
  assert.equal(grant.refresh, undefined);
  assert.equal(credentials.records.get(nativeKey('fixture-provider')).payload.refresh, undefined);
  assert.equal(credentials.records.get(nativeKey('fixture-provider')).payload.arbitrary, undefined);
  assert.equal(credentials.records.get(nativeKey('fixture-provider')).payload.externalManaged.owner, 'external-managed');
});

test('canonical no-op reads ignore a stale credential watcher cache', async () => {
  const credentials = memoryCredentials();
  const runtime = createConnectionRuntime(credentials, unavailableNative);
  await runtime.connections.connect('minimax', { access: 'current' });
  credentials.readRecord = async () => ({ kind: 'grant', payload: { mode: 'key', access: 'stale', revision: 'old' } });
  assert.equal((await runtime.resolve('minimax')).access, 'current');
});

test('native context uses the resolver observed grant rather than a later mutable record', async () => {
  const credentials = memoryCredentials(), observed = new WeakMap();
  const nativeResolve = async () => {
    const grant = { access: 'request-a' };
    observed.set(grant, { type: 'oauth', access: 'raw-a', accountId: 'account-a' });
    credentials.records.set(nativeKey('openai-codex'), { kind: 'grant', payload: { access: 'raw-b', accountId: 'account-b' } });
    return grant;
  };
  nativeResolve.rawGrant = grant => observed.get(grant);
  const runtime = createConnectionRuntime(credentials, nativeResolve);
  const context = await runtime.contextFor('openai-codex');
  assert.equal(context.access, 'request-a'); assert.equal(context.rawGrant.access, 'raw-a'); assert.equal(context.rawGrant.accountId, 'account-a');
});

test('Kimi OAuth region follows explicit scope and issuer host, with legacy native CN default', async () => {
  for (const [raw, apiBase, expected] of [
    [{ type: 'oauth', access: 'a' }, undefined, 'cn'],
    [{ type: 'oauth', access: 'a' }, 'https://api.kimi.ai/coding/v1', 'global'],
    [{ type: 'oauth', access: 'a', region: 'global' }, 'https://api.kimi.com/coding/v1', 'global'],
    [{ type: 'oauth', access: 'a' }, 'https://api.kimi.ai.attacker.invalid', 'cn'],
  ]) {
    const credentials = memoryCredentials(), native = async () => ({ access: 'a', apiBase });
    native.rawGrant = () => raw;
    const context = await createConnectionRuntime(credentials, native).contextFor('kimi-coding');
    assert.equal(context.region, expected);
  }
  const credentials = memoryCredentials(), runtime = createConnectionRuntime(credentials, unavailableNative);
  await runtime.connections.connect('kimi-coding', { access: 'key' });
  assert.equal((await runtime.contextFor('kimi-coding')).region, undefined);
});
