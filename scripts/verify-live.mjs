#!/usr/bin/env node
/**
 * Explicit live, read-only supplier acceptance. Never invokes inference.
 * node scripts/verify-live.mjs --runtime /path/to/runtime --plan /private/plan.json --out /path/to/report.json
 * Plan: { entries: [{provider:'openai-codex',mode:'local',source:'codex'},
 *   {provider:'openrouter',mode:'local',source:'opencode'},
 *   {provider:'xai',mode:'native',credentialsFile:'/canonical/.credentials.yaml'}] }
 * Native refreshes commit only to the original credential file; all connection
 * metadata, local-source mirrors, settings and pulls use a disposable profile.
 * --self-test uses fake sources and intercepts all supplier requests.
 */
import assert from 'node:assert/strict';
import { execFile as execCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execCallback);
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const prefix = 'DSH_LIVE_RESULT=';
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const fail = (code, details = {}) => Object.assign(new Error(code), { safeCode: code, safeDetails: details });
const safeError = error => ({ code: error?.safeCode ?? 'verification-failed', ...(error?.safeDetails ?? {}) });
const atomic = async (path, value) => { const temporary = `${path}.${randomUUID()}.tmp`; await mkdir(dirname(path), { recursive: true }); await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, path); };
const sourcePaths = (entry, environment) => entry.source === 'codex'
  ? join(environment.CODEX_HOME || join(environment.HOME, '.codex'), 'auth.json')
  : join(environment.XDG_DATA_HOME || join(environment.HOME, '.local', 'share'), 'opencode', 'auth.json');
const redactedModel = model => ({ idHash: hash(model.id), role: model.role, source: model.source, entitlement: model.entitlement,
  declaredCapabilities: ['input', 'output', 'tools', 'reasoning', 'reasoningEfforts', 'contextWindow', 'maxTokens', 'compat'].filter(key => model[key] !== undefined) });
const redactUsage = result => ({ status: result.status, source: result.snapshot?.source, observedAt: result.snapshot?.observedAt,
  windowCount: result.snapshot?.windows?.length ?? 0, balanceCount: result.snapshot?.balances?.length ?? 0,
  units: [...new Set([...(result.snapshot?.windows ?? []), ...(result.snapshot?.balances ?? [])].map(row => row.unit).filter(Boolean))],
  resetCount: (result.snapshot?.windows ?? []).filter(row => row.resetAt || row.nextRegenAt).length,
  planPresent: !!result.snapshot?.plan, noteCodes: result.snapshot?.notes ?? [],
});

try {
  if (argument('--worker')) await worker(argument('--worker'), resolve(argument('--sandbox')));
  else await orchestrate();
} catch (error) {
  // Never print stack, raw HTTP bodies, child stderr, source files or tokens.
  const result = { ok: false, error: safeError(error) };
  if (argument('--worker')) process.stdout.write(prefix + JSON.stringify(result) + '\n');
  else { if (argument('--out')) await atomic(resolve(argument('--out')), result); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); }
  process.exitCode = 1;
}

async function orchestrate() {
  const runtime = resolve(argument('--runtime') ?? join(root, 'node_modules/.dsh-peers-0.2.2-rc.3'));
  const modules = runtime.endsWith('node_modules') ? runtime : join(runtime, 'node_modules');
  const selfTest = process.argv.includes('--self-test');
  let plan;
  if (selfTest) plan = { entries: [{ provider: 'openai-codex', mode: 'local', source: 'codex' }, { provider: 'openrouter', mode: 'local', source: 'opencode' }] };
  else {
    const path = argument('--plan');
    if (!path || !isAbsolute(path)) throw fail('absolute-private-plan-required');
    if ((await stat(path)).mode & 0o077) throw fail('plan-file-must-be-owner-only');
    plan = JSON.parse(await readFile(path, 'utf8'));
  }
  if (!Array.isArray(plan.entries) || !plan.entries.length || plan.entries.length > 10) throw fail('invalid-plan');
  const supported = new Set(['openai-codex', 'openrouter', 'xai']);
  for (const entry of plan.entries) {
    if (!supported.has(entry.provider) || !['native', 'local'].includes(entry.mode)) throw fail('unsupported-live-plan-entry');
    if (entry.mode === 'local' && !['codex', 'opencode'].includes(entry.source)) throw fail('unsupported-local-source');
    if (entry.mode === 'native' && (!isAbsolute(entry.credentialsFile ?? '') || entry.provider !== 'xai')) throw fail('canonical-native-source-required');
    if (Object.keys(entry).some(key => !['provider', 'mode', 'source', 'credentialsFile'].includes(key))) throw fail('unexpected-plan-field');
  }
  if (new Set(plan.entries.map(entry => entry.provider)).size !== plan.entries.length) throw fail('duplicate-provider');
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-oauth-live-'));
  const manifest = { marker: randomUUID(), createdAt: new Date().toISOString(), selfTest, entries: plan.entries };
  try {
    await mkdir(join(sandbox, 'plugin'), { recursive: true });
    for (const path of ['src', 'package.json', 'client.js', 'index.html', 'auth.html', 'app.js', 'providers.js', 'styles.css', 'theme.js']) await cp(join(root, path), join(sandbox, 'plugin', path), { recursive: true });
    await symlink(modules, join(sandbox, 'plugin/node_modules'), 'dir');
    const environment = { ...process.env, DSH_HOME: join(sandbox, 'home'), DSH_OAUTH_LIVE_MARKER: manifest.marker };
    if (selfTest) {
      environment.CODEX_HOME = join(sandbox, 'fixtures/codex'); environment.XDG_DATA_HOME = join(sandbox, 'fixtures/data');
      const jwt = `mock.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
      await atomic(join(environment.CODEX_HOME, 'auth.json'), { auth_mode: 'chatgpt', tokens: { access_token: jwt, refresh_token: 'never-copy-refresh', account_id: 'fixture-account' } });
      await atomic(join(environment.XDG_DATA_HOME, 'opencode/auth.json'), { openrouter: { type: 'api', key: 'fixture-router-key' } });
    }
    await atomic(join(sandbox, 'manifest.json'), manifest);
    const sourceBefore = new Map();
    for (const entry of plan.entries.filter(row => row.mode === 'local')) {
      const path = sourcePaths(entry, environment);
      sourceBefore.set(entry.provider, hash(await readFile(path)));
    }
    const stages = [];
    for (const stage of ['import-and-query', 'restart-and-query']) {
      try {
        const { stdout } = await execFile(process.execPath, [script, '--worker', stage, '--sandbox', sandbox], { env: environment, cwd: sandbox, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
        const line = stdout.split('\n').find(line => line.startsWith(prefix));
        if (!line) throw fail('worker-result-missing', { stage });
        const result = JSON.parse(line.slice(prefix.length)); if (!result.ok) throw fail('worker-failed', { stage, workerError: result.error });
        stages.push(result);
      } catch (error) {
        const line = typeof error.stdout === 'string' ? error.stdout.split('\n').find(line => line.startsWith(prefix)) : undefined;
        if (line) throw fail('live-stage-failed', { stage, result: JSON.parse(line.slice(prefix.length)) });
        throw error.safeCode ? error : fail('worker-execution-failed', { stage });
      }
    }
    assert.notEqual(stages[0].pid, stages[1].pid);
    const sourceUnchanged = [];
    for (const entry of plan.entries.filter(row => row.mode === 'local')) sourceUnchanged.push({ provider: entry.provider, unchanged: sourceBefore.get(entry.provider) === hash(await readFile(sourcePaths(entry, environment))) });
    const versions = {};
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-credentials-local', '@deepseek-ai/dsh-llm-pi-ai', '@earendil-works/pi-ai']) versions[name] = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8')).version;
    const sourceSha256 = {};
    for (const name of ['package.json', ...(await readdir(join(sandbox, 'plugin/src'), { recursive: true })).filter(name => name.endsWith('.js') && !name.endsWith('.test.js')).map(name => `src/${name}`)]) sourceSha256[name] = hash(await readFile(join(sandbox, 'plugin', name)));
    const report = { ok: true, checkedAt: new Date().toISOString(), mode: selfTest ? 'offline-harness-self-test' : 'live-provider-read-only', versions,
      providers: plan.entries.map(({ provider, mode, source }) => ({ provider, mode, ...(source ? { source } : {}) })), stages, sourceUnchanged, sourceSha256,
      boundaries: { inferenceRequests: 0, liveProviderReads: !selfTest, profile: 'temporary isolated profile removed after verification', credentials: 'local sources read-only; native OAuth uses original canonical record and atomic refresh only', secretsInReport: false, usageAmountsInReport: false, sourcePathsInReport: false, longTermElapsedDaysProven: false } };
    if (argument('--out')) await atomic(resolve(argument('--out')), report);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}

async function worker(stage, sandbox) {
  const manifest = JSON.parse(await readFile(join(sandbox, 'manifest.json'), 'utf8'));
  if (manifest.marker !== process.env.DSH_OAUTH_LIVE_MARKER || process.env.DSH_HOME !== join(sandbox, 'home')) throw fail('worker-sandbox-mismatch');
  const pluginRoot = join(sandbox, 'plugin');
  const selected = createRequire(join(pluginRoot, 'package.json'));
  const load = name => import(pathToFileURL(selected.resolve(name)).href);
  const [{ Context, Service }, { CredentialProvider, credentialKey }, local, adapter, authorization] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-credentials'), load('@deepseek-ai/dsh-credentials-local'), load('@deepseek-ai/dsh-llm-pi-ai'), load('@deepseek-ai/dsh-authorization'),
  ]);
  const profile = join(sandbox, 'home/profiles/live-check'); await mkdir(profile, { recursive: true });
  const settingsPath = join(profile, 'live-settings.json');
  let settings = { providers: {} };
  try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let revision = 0;
  const contexts = [];
  const isolated = new Context(); contexts.push(isolated);
  await isolated.plugin(local.default, { path: join(sandbox, 'home/.credentials.yaml'), watch: false });
  const native = new Map();
  for (const entry of manifest.entries.filter(row => row.mode === 'native')) {
    const source = new Context(); contexts.push(source);
    await source.plugin(local.default, { path: entry.credentialsFile, watch: false });
    native.set(credentialKey('llm-pi-ai', entry.provider), source.credentials);
  }
  class SelectedCredentials extends CredentialProvider {
    target(key) { return native.get(key) ?? isolated.credentials; }
    resolve(ref) { return isolated.credentials.resolve(ref); }
    describe(ref) { return isolated.credentials.describe(ref); }
    set(ref, value) { return isolated.credentials.set(ref, value); }
    unset(ref) { return isolated.credentials.unset(ref); }
    readRecord(key) { return this.target(key).readRecord(key); }
    describeRecord(key) { return this.target(key).describeRecord(key); }
    modifyRecord(key, mutate) { return this.target(key).modifyRecord(key, mutate); }
    deleteRecord(key) { if (native.has(key)) throw fail('canonical-deletion-forbidden'); return isolated.credentials.deleteRecord(key); }
    async listRecords() { return [...await isolated.credentials.listRecords(), ...await Promise.all([...native].map(async ([key, value]) => ({ key, ...(await value.describeRecord(key)) })))]; }
  }
  class PersistentSettings extends Service {
    constructor(ctx) { super(ctx, 'settings'); }
    describe() { return [{ ns: 'llm-pi-ai', user: structuredClone(settings), value: structuredClone(settings), revision }]; }
    async mutate(namespace, operations, expectedRevision) {
      assert.equal(namespace, 'llm-pi-ai'); assert.equal(expectedRevision, revision);
      const next = structuredClone(settings);
      for (const operation of operations) {
        let parent = next; for (const part of operation.path.slice(0, -1)) parent = parent[part] ??= {};
        if (operation.op === 'unset') delete parent[operation.path.at(-1)]; else parent[operation.path.at(-1)] = structuredClone(operation.value);
      }
      adapter.Config(next); await atomic(settingsPath, next); settings = next; revision++;
    }
  }
  const routes = [];
  class WebServer extends Service { constructor(ctx) { super(ctx, 'webServer'); } register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } }
  const ctx = new Context(); contexts.push(ctx);
  ctx.provide('profileContext', { name: 'live-check', dir: profile, home: process.env.DSH_HOME, patchPath: join(profile, 'cordis.patch.yml') });
  const requests = [];
  const originalFetch = globalThis.fetch;
  const allowed = new Map([
    ['chatgpt.com', new Set(['/backend-api/codex/models', '/backend-api/wham/usage'])],
    ['openrouter.ai', new Set(['/api/v1/models/user', '/api/v1/key', '/api/v1/credits'])],
    ['cli-chat-proxy.grok.com', new Set(['/v1/models', '/v1/billing'])], ['api.x.ai', new Set(['/v1/models'])],
    ['auth.x.ai', new Set(['/oauth2/token'])],
  ]);
  let loopback;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.origin === loopback) return originalFetch(url, options);
    const method = options.method ?? 'GET';
    if (target.protocol !== 'https:' || !allowed.get(target.hostname)?.has(target.pathname) || !['GET', 'POST'].includes(method)) throw fail('unexpected-network-route');
    if (method !== 'GET' && !(target.hostname === 'auth.x.ai' && target.pathname === '/oauth2/token' && new URLSearchParams(options.body).get('grant_type') === 'refresh_token')) throw fail('non-read-only-network-request');
    const item = { host: target.hostname, path: target.pathname, method }; requests.push(item);
    try {
      const response = manifest.selfTest ? fixture(target) : await originalFetch(url, { ...options, redirect: 'error' });
      item.status = response.status; return response;
    } catch (error) { item.failed = true; throw error; }
  };
  let server;
  const result = { ok: false, stage, pid: process.pid, providers: [], requests };
  try {
    await ctx.plugin(SelectedCredentials); await ctx.plugin(PersistentSettings); await ctx.plugin(WebServer); await ctx.plugin(authorization.default);
    for (const entry of manifest.entries.filter(row => row.mode === 'native')) ctx.authorization.registerFlow({ key: credentialKey('llm-pi-ai', entry.provider), label: entry.provider, methods: [{ id: 'oauth', label: 'Existing authorization' }], async run() { throw fail('live-login-forbidden'); } });
    await ctx.plugin(await import(pathToFileURL(join(pluginRoot, 'src/index.js')).href));
    const route = routes.find(route => route.path === '/oauth'); if (!route) throw fail('host-route-missing');
    server = createServer((req, res) => { if (!req.url?.startsWith('/oauth/')) { res.writeHead(404); res.end(); return; } void route.handler(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); loopback = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, body) => {
      const response = await fetch(`${loopback}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw fail('panel-request-failed', { operation: path, provider: body?.provider, httpStatus: response.status, requests });
      return data;
    };
    const { createPullStore } = await import(pathToFileURL(join(pluginRoot, 'src/pulls.js')).href);
    const pulls = createPullStore(profile);
    const prior = stage === 'restart-and-query' ? JSON.parse(await readFile(join(profile, 'live-expectations.json'), 'utf8')) : {};
    if (stage === 'restart-and-query') {
      const cache = JSON.parse(await readFile(join(profile, 'dsh-oauth-usage.json'), 'utf8'));
      for (const entry of manifest.entries) assert.equal(cache.entries[entry.provider].result.snapshot.observedAt, prior[entry.provider].observedAt);
      // Prove the persisted observation first, then remove only the disposable
      // cache to make the restarted query a genuine second supplier read.
      await rm(join(profile, 'dsh-oauth-usage.json'));
    }
    const expected = {};
    for (const entry of manifest.entries) {
      const id = entry.provider;
      if (stage === 'import-and-query' && entry.mode === 'local') await request('/oauth/api/import', { provider: id, source: entry.source });
      if (stage === 'restart-and-query') {
        const pull = await pulls.read(id); assert.equal(pull?.expiresAt, null);
        assert.equal(hash(pull), prior[id].pullHash); assert.equal(hash(settings.providers[id]), prior[id].routeHash);
      }
      const { models } = await request('/oauth/api/models', { provider: id });
      if (!Array.isArray(models) || !models.some(model => model.role === 'chat')) throw fail('no-chat-models-returned', { provider: id });
      const chosen = stage === 'import-and-query' ? models.filter(model => model.role === 'chat').slice(0, 2).map(model => model.id) : prior[id].selected;
      if (!chosen.every(id => models.some(model => model.id === id))) throw fail('selected-model-not-in-restarted-catalog', { provider: id });
      if (stage === 'import-and-query') await request('/oauth/api/pull', { provider: id, models: chosen, expiresAt: null });
      const pull = await pulls.read(id); assert.equal(pull.expiresAt, null); assert.equal(pull.models.length, chosen.length); adapter.Config(settings);
      if (entry.mode === 'local') {
        const connection = await isolated.credentials.readRecord(credentialKey('dsh-oauth-connections', id));
        assert.equal(connection?.payload.mode, 'local');
        assert.equal(Object.hasOwn(connection.payload, 'access'), false); assert.equal(Object.hasOwn(connection.payload, 'refresh'), false);
        const mirrored = await isolated.credentials.readRecord(credentialKey('llm-pi-ai', id));
        if (mirrored) assert.equal(Object.hasOwn(mirrored.payload, 'refresh'), false);
        const reference = settings.providers[id]?.apiKeyEnv;
        if (reference) assert.equal(typeof (await isolated.credentials.resolve(reference))?.value, 'string');
      }
      const usage = await request('/oauth/api/usage', { provider: id, force: true });
      if (!['fresh', 'partial'].includes(usage.status) || !usage.snapshot || !(usage.snapshot.windows?.length || usage.snapshot.balances?.length)) throw fail('live-usage-unavailable', { provider: id, usage: redactUsage(usage), requests });
      const unexpectedNotes = (usage.snapshot.notes ?? []).filter(note => !['account-balance-needs-permission', 'management-balance-has-independent-account-scope'].includes(note));
      if (usage.status === 'partial' && (id !== 'openrouter' || unexpectedNotes.length)) throw fail('unexpected-partial-usage', { provider: id, usage: redactUsage(usage), requests });
      expected[id] = { selected: chosen, pullHash: hash(pull), routeHash: hash(settings.providers[id]), observedAt: usage.snapshot.observedAt };
      result.providers.push({ provider: id, source: entry.mode === 'local' ? entry.source : 'canonical-native', catalogCount: models.length,
        catalogIdHash: hash(models.map(model => model.id).sort()), importedCount: chosen.length, imported: pull.models.map(redactedModel), permanent: pull.expiresAt === null,
        persistentCapabilitiesVerified: stage === 'restart-and-query', usage: redactUsage(usage) });
    }
    if (stage === 'import-and-query') await atomic(join(profile, 'live-expectations.json'), expected);
    const visible = await request('/oauth/api/providers');
    for (const entry of manifest.entries) { const row = visible.providers.find(row => row.id === entry.provider); assert.equal(row.loggedIn, true); assert.equal(row.pullPermanent, true); }
    const providerCredentialsMode = (await stat(join(sandbox, 'home/.credentials.yaml'))).mode & 0o777;
    assert.equal(providerCredentialsMode, 0o600); result.credentialFileMode = '0600'; result.ok = true;
    process.stdout.write(prefix + JSON.stringify(result) + '\n');
  } catch (error) { throw error.safeCode ? error : fail('live-assertion-failed', { stage, requests }); }
  finally { globalThis.fetch = originalFetch; if (server) await new Promise(resolve => server.close(resolve)); for (const context of contexts.reverse()) await context.fiber.dispose(); }
}

function fixture(url) {
  if (url.pathname.endsWith('/models') || url.pathname.endsWith('/models/user')) return Response.json({ data: [{ id: 'fixture-model', name: 'Fixture', input_modalities: ['text', 'image'], context_window: 128000, max_output_tokens: 8192, supported_parameters: ['tools'], reasoning_efforts: ['high'] }] });
  if (url.pathname.endsWith('/usage')) return Response.json({ plan_type: 'fixture-plan', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 300 } } });
  if (url.pathname.endsWith('/key')) return Response.json({ data: { limit: 10, usage: 2, limit_remaining: 8 } });
  throw fail('unexpected-self-test-network-request');
}
