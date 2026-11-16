import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalSources } from './local-imports.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const jwt = (expires = NOW + 3600000) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: expires / 1000 })).toString('base64url')}.fixture-signature`;
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-local-import-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = { codex: join(home, '.codex', 'auth.json'), opencode: join(home, '.local', 'share', 'opencode', 'auth.json') };
  async function put(source, value) { await mkdir(join(paths[source], '..'), { recursive: true }); await writeFile(paths[source], typeof value === 'string' ? value : JSON.stringify(value)); }
  return { home, paths, put, ...createLocalSources({ home, now: () => NOW }) };
}

test('empty isolated roots discover known sources without leaking host paths', async t => {
  const f = await fixture(t), sources = await f.discoverLocalSources();
  assert.deepEqual(sources.map(x => x.id), ['codex', 'opencode']);
  assert.ok(sources.every(x => !x.available && x.reasonCode === 'source-unavailable'));
  assert.equal(JSON.stringify(sources).includes(f.home), false);
});

test('Codex ChatGPT token normalizes account and expiry, but never exports refresh or ID tokens', async t => {
  const f = await fixture(t), access = jwt();
  await f.put('codex', { auth_mode: 'chatgpt', tokens: { access_token: access, refresh_token: 'synthetic-refresh-secret', id_token: 'synthetic-id-secret', account_id: 'account-fixture' }, last_refresh: '2026-11-16T11:00:00Z' });
  const preview = await f.discoverLocalSources();
  assert.deepEqual(preview[0].providers, [{ provider: 'openai-codex', authType: 'oauth', available: true }]);
  assert.equal(JSON.stringify(preview).includes(access), false);
  assert.equal(JSON.stringify(preview).includes('secret'), false);
  assert.equal(JSON.stringify(preview).includes('account-fixture'), false);
  const read = await f.readLocalSource('codex', 'openai-codex');
  assert.equal(read.owner, 'external-managed');
  assert.deepEqual(read.source, { id: 'codex', provider: 'openai-codex' });
  assert.deepEqual(read.grant, { type: 'oauth', access, expires: NOW + 3600000, accountId: 'account-fixture' });
  assert.equal(JSON.stringify(read).includes('refresh-secret'), false);
});

test('source changes and logout are observed on every read, without a plugin-owned refresh', async t => {
  const f = await fixture(t);
  await f.put('codex', { tokens: { access_token: 'synthetic-token-a', refresh_token: 'must-not-copy' } });
  const first = await f.readLocalSource('codex', 'openai-codex');
  await f.put('codex', { tokens: { access_token: 'synthetic-token-b' } });
  const second = await f.readLocalSource('codex', 'openai-codex');
  assert.equal(first.grant.access, 'synthetic-token-a');
  assert.equal(second.grant.access, 'synthetic-token-b');
  assert.equal(second.grant.expires, undefined);
  await rm(f.paths.codex);
  await assert.rejects(f.readLocalSource('codex', 'openai-codex'), { code: 'source-unavailable' });
});

for (const lifetime of [-1000, 0, 59999, 60000]) {
  test(`Codex expired or near-expiry source (${lifetime} ms) asks the source CLI to refresh`, async t => {
    const f = await fixture(t);
    await f.put('codex', { tokens: { access_token: jwt(NOW + lifetime) } });
    const preview = await f.discoverLocalSources();
    assert.equal(preview[0].providers[0].reasonCode, 'source-reauth-required');
    await assert.rejects(f.readLocalSource('codex', 'openai-codex'), error => error.code === 'source-reauth-required' && /source CLI/.test(error.message));
  });
}

test('Codex API-key mode is OpenAI, never a ChatGPT subscription', async t => {
  const f = await fixture(t);
  await f.put('codex', { auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-openai-key', tokens: { access_token: jwt() } });
  const read = await f.readLocalSource('codex', 'openai');
  assert.deepEqual(read.grant, { type: 'api_key', access: 'synthetic-openai-key' });
  await assert.rejects(f.readLocalSource('codex', 'openai-codex'), { code: 'source-unavailable' });
});

test('OpenCode maps openai OAuth only, and retains true provider IDs for API keys', async t => {
  const f = await fixture(t);
  await f.put('opencode', {
    openai: { type: 'oauth', access: 'synthetic-codex', refresh: 'do-not-copy', expires: NOW + 3600000, accountId: 'account-a' },
    anthropic: { type: 'oauth', access: 'synthetic-claude', refresh: 'do-not-copy', expires: NOW + 3600000 },
    'opencode-go': { type: 'api', key: 'synthetic-go-key' },
    'opencode-zen': { type: 'api', key: 'synthetic-zen-key' },
    minimax: { type: 'api', key: 'synthetic-brand-key' },
    openrouter: { type: 'api', key: 'synthetic-router-key' },
  });
  const preview = (await f.discoverLocalSources())[1];
  assert.equal(preview.providers.length, 6);
  assert.equal(preview.providers.some(x => x.provider === 'openai'), false);
  assert.equal((await f.readLocalSource('opencode', 'openai-codex')).grant.refresh, undefined);
  assert.deepEqual((await f.readLocalSource('opencode', 'opencode-go')).grant, { type: 'api_key', access: 'synthetic-go-key' });
  assert.equal((await f.readLocalSource('opencode', 'minimax')).provider, 'minimax');
  await f.put('opencode', { openai: { type: 'api', key: 'synthetic-openai-api' } });
  assert.equal((await f.readLocalSource('opencode', 'openai')).grant.type, 'api_key');
  await assert.rejects(f.readLocalSource('opencode', 'openai-codex'), { code: 'source-unavailable' });
});

test('ambiguous OpenCode aliases are visible but cannot silently overwrite one another', async t => {
  const f = await fixture(t);
  await f.put('opencode', { openai: { type: 'oauth', access: 'account-a' }, 'openai-codex': { type: 'oauth', access: 'account-b' } });
  assert.deepEqual((await f.discoverLocalSources())[1].providers, [{ provider: 'openai-codex', authType: 'oauth', available: false, reasonCode: 'ambiguous-source' }]);
  await assert.rejects(f.readLocalSource('opencode', 'openai-codex'), { code: 'ambiguous-source' });
});

test('OpenCode explicit expiry is checked and valid neighbors survive an invalid entry', async t => {
  const f = await fixture(t);
  await f.put('opencode', { anthropic: { type: 'oauth', access: 'synthetic-claude', expires: NOW - 1 }, openrouter: { type: 'api', key: 'synthetic-key' } });
  const source = (await f.discoverLocalSources())[1];
  assert.equal(source.available, true);
  assert.equal(source.providers[0].reasonCode, 'source-reauth-required');
  assert.equal(source.providers[1].available, true);
  await assert.rejects(f.readLocalSource('opencode', 'anthropic'), { code: 'source-reauth-required' });
});

test('unknown source formats and invalid token content are rejected without raw messages', async t => {
  const f = await fixture(t);
  for (const payload of [[], null, 'not JSON secret-value', { version: 2, credentials: [{ access: 'secret-value' }] }]) {
    await f.put('opencode', payload === null ? 'null' : payload);
    const source = (await f.discoverLocalSources())[1];
    assert.equal(source.available, false);
    assert.equal(JSON.stringify(source).includes('secret-value'), false);
  }
  await f.put('opencode', { anthropic: { type: 'oauth', access: 'token\nInjected: yes' } });
  await assert.rejects(f.readLocalSource('opencode', 'anthropic'), { code: 'invalid-source' });
});

test('paths, source IDs, and inherited object properties cannot select arbitrary files', async t => {
  const f = await fixture(t);
  for (const source of [f.paths.codex, '../codex', 'constructor', '__proto__', { path: f.paths.codex }]) await assert.rejects(f.readLocalSource(source, 'openai-codex'), { code: 'unsupported-source' });
  for (const provider of ['../openai', '/tmp/auth.json', { provider: 'openai' }]) await assert.rejects(f.readLocalSource('codex', provider), { code: 'unsupported-provider' });
});

test('trusted absolute server root overrides stay fixed and source files remain unchanged', async t => {
  const f = await fixture(t), codexHome = join(f.home, 'alternate-codex'), dataHome = join(f.home, 'alternate-data');
  await mkdir(codexHome); await mkdir(join(dataHome, 'opencode'), { recursive: true });
  const path = join(codexHome, 'auth.json'), original = JSON.stringify({ tokens: { access_token: jwt(), refresh_token: 'owned-by-cli' } });
  await writeFile(path, original);
  await writeFile(join(dataHome, 'opencode', 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'synthetic-key' } }));
  const custom = createLocalSources({ home: f.home, codexHome, openCodeDataHome: dataHome, now: () => NOW });
  assert.equal((await custom.readLocalSource('codex', 'openai-codex')).grant.type, 'oauth');
  assert.equal((await custom.readLocalSource('opencode', 'openrouter')).grant.type, 'api_key');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.throws(() => createLocalSources({ home: f.home, codexHome: '../relative' }), { code: 'invalid-configuration' });
});

test('symlinks, directories, and over-size credentials are not opened as authorization documents', async t => {
  const f = await fixture(t);
  await mkdir(join(f.paths.codex, '..'), { recursive: true });
  const other = join(f.home, 'other.json');
  await writeFile(other, JSON.stringify({ tokens: { access_token: jwt() } }));
  await symlink(other, f.paths.codex);
  await assert.rejects(f.readLocalSource('codex', 'openai-codex'), { code: 'source-unavailable' });
  await rm(f.paths.codex); await mkdir(f.paths.codex);
  await assert.rejects(f.readLocalSource('codex', 'openai-codex'), { code: 'invalid-source' });
  await rm(f.paths.codex, { recursive: true });
  await writeFile(f.paths.codex, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(f.readLocalSource('codex', 'openai-codex'), { code: 'invalid-source' });
});

test('unverified JWT identity fields are not used as account metadata', async t => {
  const f = await fixture(t), payload = Buffer.from(JSON.stringify({ exp: NOW / 1000 + 3600, account_id: 'unverified-account', email: 'private@example.invalid' })).toString('base64url');
  await f.put('codex', { tokens: { access_token: `header.${payload}.signature` } });
  const out = await f.readLocalSource('codex', 'openai-codex');
  assert.equal(out.grant.accountId, undefined);
  assert.equal(JSON.stringify(await f.discoverLocalSources()).includes('private@example.invalid'), false);
});

test('provider dictionary names cannot disclose another entry secret in preview', async t => {
  const f = await fixture(t);
  await f.put('opencode', { 'synthetic-token-value': { type: 'api', key: 'other-key' }, anthropic: { type: 'oauth', access: 'synthetic-token-value' } });
  const preview = await f.discoverLocalSources();
  assert.equal(JSON.stringify(preview).includes('synthetic-token-value'), false);
  assert.deepEqual(preview[1].providers.map(x => x.provider), ['anthropic']);
});
