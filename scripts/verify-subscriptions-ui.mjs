/** Subscription UI acceptance against local mocks. Never contacts a provider or reads credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(process.env.DSH_PLAYWRIGHT_MODULE || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outArg = process.argv.indexOf('--out-dir');
const outDir = resolve(outArg >= 0 ? process.argv[outArg + 1] : join(root, 'artifacts/subscriptions-ui'));
await mkdir(outDir, { recursive: true });
const completed = [], pageErrors = [], blockedRequests = [], calls = [];
let usageMode = 'fresh', lateUsage, releaseLate;
const providers = [
  { id: 'google-antigravity', name: 'Google Antigravity', cliCatalog: true, flow: 'pkce', authMethods: ['oauth', 'local'], usageSupported: true, loggedIn: true, pullable: false, supportReason: 'host-oauth-model-integration-unavailable', pulledModels: [] },
  { id: 'qwen', name: 'Qwen CLI', flow: 'device_code', authMethods: ['oauth'], usageSupported: false, loggedIn: true, pullable: true, pulledModels: [] },
  { id: 'new-api', name: 'New API', flow: 'key', authMethods: ['key'], keyConnect: true, usageSupported: true, loggedIn: false, pulledModels: [] },
  { id: 'zenmux', name: 'ZenMux', flow: 'key', authMethods: ['key'], keyConnect: true, usageSupported: true, loggedIn: false, pulledModels: [] },
  { id: 'openai-codex', name: 'ChatGPT / Codex', flow: 'pkce', authMethods: ['oauth', 'local'], usageSupported: true, loggedIn: true, tokenPreview: 'DO-NOT-DISPLAY-TOKEN', pulledModels: [] },
  { id: 'anthropic', name: 'Claude Pro/Max', flow: 'pkce', authMethods: ['oauth'], usageSupported: true, loggedIn: false, pullable: false },
];
const models = [{ id: 'mock-model', name: 'Mock <img src=x onerror=alert(1)>', role: 'chat', input: ['text', 'image'], output: ['text'], tools: true, contextWindow: 200000, maxTokens: 32000, reasoningEfforts: { low: 'low', high: 'high' }, source: 'public-catalog', entitlement: 'unknown' }, { id: 'mock-image', name: 'Image model', role: 'image', input: ['text'], output: ['image'], source: 'account', entitlement: 'account' }];
const snapshot = { plan: { name: 'Mock subscription', renewsAt: '2026-12-01T00:00:00Z' }, source: 'provider-api', observedAt: '2026-11-16T12:00:00Z', windows: [
  { id: 'five-hour', label: 'Five-hour window', unit: 'percent', usedPercent: 25, resetAt: '2026-11-16T17:00:00Z', scope: 'account' },
  { id: 'monthly', label: 'Monthly cap', unit: 'credits', limit: '500', scope: 'account', nextRegenAt: '2026-11-17T00:00:00Z', nextRegenPercent: 10 },
], balances: [{ id: 'payg', label: 'PAYG', amount: '-2.5', currency: 'USD', unit: 'money' }], notes: [] };
let auth = { attemptId: 'mock-attempt', status: 'pending', prompt: { id: 'code', kind: 'text', message: 'Paste authorization code', placeholder: 'code' } };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (pathname.startsWith('/oauth/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : {};
      calls.push({ pathname, body });
      if (pathname.endsWith('/providers')) return json({ providers });
      if (pathname.endsWith('/connect') || pathname.endsWith('/connection')) {
        const item = providers.find((item) => item.id === body.provider);
        assert.ok(item);
        item.loggedIn = true; item.credentialConfigured = true;
        if (body.billingAccess) item.billingCredentialConfigured = true;
        item.connection = { ...item.connection, ...Object.fromEntries(Object.entries(body).filter(([key]) => !['provider', 'access', 'billingAccess'].includes(key))) };
        return json({ ok: true });
      }
      if (pathname.endsWith('/models')) return json({ models });
      if (pathname.endsWith('/pull')) {
        const item = providers.find((item) => item.id === body.provider);
        item.pulledModels = models.filter((item) => body.models.includes(item.id));
        item.pullPermanent = body.expiresAt === null; item.pullExpiresAt = body.expiresAt;
        return json({ models: item.pulledModels });
      }
      if (pathname.endsWith('/usage')) {
        if (usageMode === 'failure') return json({ error: 'Mock usage service offline' }, 503);
        if (usageMode === 'late') { lateUsage?.(); await new Promise((resolve) => { releaseLate = resolve; }); }
        if (['needs-permission', 'needs-configuration', 'rate-limited', 'reauth-required'].includes(usageMode)) return json({ status: usageMode, message: 'Management key required', lastAttemptAt: new Date().toISOString() });
        return json({ status: usageMode === 'partial' ? 'partial' : 'fresh', snapshot, lastAttemptAt: new Date().toISOString() });
      }
      if (pathname.endsWith('/import/sources')) return json({ sources: [
        { id: 'codex', label: 'Codex CLI', available: true, providers: [{ provider: 'openai-codex', authType: 'oauth', available: true }] },
        { id: 'opencode', label: 'OpenCode', available: false, providers: [{ provider: 'openai-codex', authType: 'oauth', available: false }] },
        { id: 'agy', label: 'Antigravity CLI (agy)', available: false, providers: [{ provider: 'google-antigravity', authType: 'oauth', available: false, reasonCode: 'source-does-not-export-credentials' }] },
      ] });
      if (pathname.endsWith('/import')) return json({ ok: true });
      if (pathname.endsWith('/logout')) { providers.find((item) => item.id === body.provider).loggedIn = false; return json({ ok: true }); }
      if (pathname.endsWith('/login')) return json(auth);
      if (pathname.endsWith('/login/status')) return json(auth);
      if (pathname.endsWith('/login/answer')) { assert.equal(body.value, 'mock-authorization-input'); providers.find((item) => item.id === body.provider).loggedIn = true; auth = { attemptId: 'mock-attempt', status: 'authorized' }; return json(auth); }
      if (pathname.endsWith('/login/cancel')) { auth = { ...auth, status: 'cancelled' }; return json(auth); }
      return json({ error: 'Unexpected mock API route' }, 404);
    }
    const name = pathname.replace(/^\/oauth\/?|^\//, '') || 'index.html';
    if (!['index.html', 'app.js', 'styles.css', 'providers.js', 'theme.js', 'auth.html'].includes(name)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript' });
    res.end(await readFile(join(root, name)));
  } catch (error) { json({ error: error.message }, 500); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
await context.route('**/*', (route) => {
  if (route.request().url().startsWith(origin)) return route.continue();
  blockedRequests.push(route.request().url()); return route.abort();
});
context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
const page = await context.newPage();
page.setDefaultTimeout(7000);
const row = (id) => page.locator(`[data-provider="${id}"]`);
try {
  await page.goto(`${origin}/oauth/`);
  await row('zenmux').getByRole('button', { name: '连接密钥', exact: true }).waitFor();
  assert.equal(await page.locator('.nav').isVisible(), true);
  assert.equal(await page.getByText('DO-NOT-DISPLAY-TOKEN').count(), 0);
  assert.equal(calls.filter((item) => item.pathname.endsWith('/usage')).length, 0);
  completed.push('Original sidebar and rows retained; credentials hidden; no automatic quota calls');
  assert.equal(await row('google-antigravity').getByRole('button', { name: '拉取模型', exact: true }).count(), 0);
  await row('google-antigravity').getByText('可查询套餐用量；当前宿主尚未接入此来源的模型调用。', { exact: true }).waitFor();
  await row('google-antigravity').getByRole('button', { name: '连接配置', exact: true }).click();
  await page.getByRole('button', { name: '改用本机 CLI 管理的授权', exact: true }).click();
  await page.getByText('AGY 通过系统钥匙串管理登录，暂无法在此导入。请在 agy 中输入 /usage 查看套餐用量。', { exact: true }).waitFor();
  assert.equal(await page.locator('#local-source-agy').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '确认复用此来源', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  completed.push('AGY shows the system-keyring limitation and links the user to the CLI usage command');
  await row('google-antigravity').getByRole('button', { name: '查看 AGY CLI 模型', exact: true }).click();
  await page.getByRole('heading', { name: 'AGY CLI 模型目录' }).waitFor();
  assert.ok(calls.some(item => item.pathname.endsWith('/models') && item.body.provider === 'google-antigravity' && item.body.source === 'agy'));
  assert.equal(await page.locator('#confirm-pull').count(), 0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await row('qwen').getByRole('button', { name: '套餐与用量', exact: true }).click();
  await row('qwen').getByText('此来源暂不提供用量', { exact: true }).waitFor();
  assert.equal(calls.filter((item) => item.pathname.endsWith('/usage')).length, 0);
  completed.push('Google usage-only integration does not promise model access; unsupported usage makes no API request');

  await row('zenmux').getByRole('button', { name: '连接密钥', exact: true }).click();
  await page.locator('#connection-access').fill('mock-inference-secret');
  await page.locator('#connection-billing').fill('mock-management-secret');
  await page.locator('#connection-label').fill('My subscription');
  assert.equal(await page.locator('#connection-access').getAttribute('type'), 'password');
  await page.locator('[data-modal-locale]').selectOption('en');
  assert.equal(await page.locator('#connection-access').inputValue(), 'mock-inference-secret');
  assert.equal(await page.locator('#connection-label').inputValue(), 'My subscription');
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('mock-inference-secret'));
  await page.getByRole('button', { name: 'Save and connect', exact: true }).click();
  await row('zenmux').getByText('Connected', { exact: true }).waitFor();
  assert.equal(calls.find((item) => item.pathname.endsWith('/connect')).body.billingAccess, 'mock-management-secret');
  assert.equal(await page.locator('#connection-access').count(), 0);
  completed.push('Key connection and distinct billing credential; locale preserves draft without persistence');

  await row('zenmux').getByRole('button', { name: 'Connection settings', exact: true }).click();
  assert.equal(await page.locator('#connection-access').count(), 0);
  assert.equal(await page.locator('#connection-billing').inputValue(), '');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.deepEqual(calls.find((item) => item.pathname.endsWith('/connection')).body, { provider: 'zenmux' });
  completed.push('Saved authorization never echoed; blank billing field retains existing credential');
  for (const region of ['cn', 'global']) {
    await row('zenmux').getByRole('button', { name: 'Connection settings', exact: true }).click();
    if (!(await page.locator('#connection-region').isVisible())) await page.locator('.scope-fields summary').click();
    await page.locator('#connection-region').selectOption(region);
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(calls.filter((item) => item.pathname.endsWith('/connection')).at(-1).body.region, region);
  }
  completed.push('Region changes use global/cn and can return to the global default without sending an empty region');

  await row('zenmux').getByRole('button', { name: 'Fetch models', exact: true }).click();
  await page.locator('.model-capabilities').getByText(/Tools supported/).waitFor();
  await page.locator('.model-capabilities').getByText(/Reasoning: low \/ high/).waitFor();
  await page.locator('.model-capabilities').getByText(/Plan entitlement unconfirmed/).waitFor();
  assert.equal(await page.locator('#modal img').count(), 0);
  assert.equal(await page.locator('#pull-permanent').isChecked(), true);
  await page.getByRole('button', { name: 'Select all / clear', exact: true }).click();
  assert.equal(await page.locator('.choice input').isChecked(), false);
  await page.getByRole('button', { name: 'Save selected models', exact: true }).click();
  await page.getByText('Select at least one chat model.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Select all / clear', exact: true }).click();
  models[0].name = 'Mock reasoning model';
  await page.getByRole('button', { name: 'Save selected models', exact: true }).click();
  await row('zenmux').getByText('Models stay enabled', { exact: true }).waitFor();
  assert.equal(calls.find((item) => item.pathname.endsWith('/pull')).body.expiresAt, null);
  completed.push('Capabilities and entitlement provenance; malicious model name escaped; single-model selection; permanent default');

  await row('zenmux').getByRole('button', { name: 'Fetch models', exact: true }).click();
  await page.locator('#pull-title').waitFor();
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 4000 });
  await page.screenshot({ path: join(outDir, 'models-en.png') });
  await page.locator('#pull-until').check();
  await page.locator('#pull-expiry').fill('2030-01-01T12:00');
  await page.getByRole('button', { name: 'Save selected models', exact: true }).click();
  await page.getByText('Choose an expiry date within the next 366 days.', { exact: true }).waitFor();
  await page.getByRole('button', { name: '7 days', exact: true }).click();
  assert.equal(await page.locator('#pull-until').isChecked(), true);
  await page.locator('[data-modal-locale]').selectOption('zh');
  assert.equal(await page.locator('#pull-until').isChecked(), true);
  assert.equal(await page.locator('.choice input').isChecked(), true);
  await page.getByRole('button', { name: '写入所选模型', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.ok(calls.filter((item) => item.pathname.endsWith('/pull')).at(-1).body.expiresAt > Date.now());
  await row('zenmux').getByRole('button', { name: '拉取模型', exact: true }).click();
  assert.equal(await page.locator('#pull-until').isChecked(), true);
  await page.keyboard.press('Escape');
  completed.push('Optional expiry remains selectable, survives locale change and reopening');

  await row('zenmux').getByRole('button', { name: '套餐与用量', exact: true }).click();
  await row('zenmux').getByText('Mock subscription', { exact: true }).waitFor();
  assert.equal(await row('zenmux').getByRole('meter').count(), 1);
  await row('zenmux').getByText('用量比例未知', { exact: true }).waitFor();
  await row('zenmux').getByText('-2.5 USD', { exact: false }).waitFor();
  await row('zenmux').getByText(/下次部分恢复/).waitFor();
  await row('zenmux').getByText(/provider-api/).waitFor();
  completed.push('Real quota windows, unknown percentages, signed balances, partial recovery and timestamp/source');

  usageMode = 'failure';
  await row('zenmux').getByRole('button', { name: '刷新用量', exact: true }).click();
  await row('zenmux').getByText('上次成功数据 · 本次更新失败', { exact: true }).waitFor();
  assert.equal(await row('zenmux').getByRole('meter').count(), 1);
  completed.push('Transient usage failure preserves a clearly stale last-good snapshot');
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 4000 });
  await page.screenshot({ path: join(outDir, 'subscriptions-zh-desktop.png'), fullPage: true });

  usageMode = 'needs-permission';
  await row('zenmux').getByRole('button', { name: '刷新用量', exact: true }).click();
  await row('zenmux').getByText('需要查询权限', { exact: true }).waitFor();
  assert.equal(await row('zenmux').getByRole('meter').count(), 0);
  assert.equal(await row('zenmux').getByText('已连接', { exact: true }).count(), 1);
  completed.push('Usage permission failure does not claim disconnected or exhausted');
  usageMode = 'needs-configuration';
  await row('zenmux').getByRole('button', { name: '刷新用量', exact: true }).click();
  await row('zenmux').getByText('需要补充查询配置', { exact: true }).waitFor();
  await row('zenmux').getByText(/请在「连接配置」中补充查询授权/).waitFor();
  assert.equal(await row('zenmux').getByRole('meter').count(), 0);
  usageMode = 'partial';
  snapshot.notes = ['subscription-split-and-reset-not-provided'];
  await row('zenmux').getByRole('button', { name: '刷新用量', exact: true }).click();
  await row('zenmux').getByText('部分数据可用', { exact: true }).waitFor();
  await row('zenmux').getByText('未提供订阅与充值分项或重置时间。', { exact: true }).waitFor();
  assert.equal(await row('zenmux').getByRole('meter').count(), 1);
  snapshot.notes = [];
  completed.push('Missing query configuration remains actionable; partial quota data retains known values and translated limitations');

  await row('openai-codex').getByRole('button', { name: '连接配置', exact: true }).click();
  await page.getByRole('button', { name: '改用本机 CLI 管理的授权', exact: true }).click();
  await page.getByText('Codex CLI', { exact: true }).waitFor();
  assert.equal(await page.locator('input[name="source"][value="opencode"]').isDisabled(), true);
  await page.locator('input[name="source"][value="codex"]').check();
  await page.getByRole('button', { name: '确认复用此来源', exact: true }).click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.deepEqual(calls.find((item) => item.pathname.endsWith('/import')).body, { source: 'codex', provider: 'openai-codex' });
  completed.push('Fixed local CLI sources reflect actual availability and selected provider');

  await row('anthropic').getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('#authorization-answer').fill('mock-authorization-input');
  await page.locator('[data-modal-locale]').selectOption('en');
  assert.equal(await page.locator('#authorization-answer').inputValue(), 'mock-authorization-input');
  await page.getByRole('button', { name: 'Submit authorization input', exact: true }).click();
  await row('anthropic').getByText('Connected', { exact: true }).waitFor();
  completed.push('Existing OAuth manual-input flow survives locale switch and confirms local credentials');

  usageMode = 'fresh';
  await row('zenmux').getByRole('button', { name: 'Refresh usage', exact: true }).click();
  await row('zenmux').getByText('Updated', { exact: true }).waitFor();
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 4000 });
  await page.screenshot({ path: join(outDir, 'subscriptions-en-desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await row('zenmux').getByRole('button', { name: 'Connection settings', exact: true }).click();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#modal').contains(document.activeElement)), true);
    for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#modal').contains(document.activeElement)), true);
    await page.screenshot({ path: join(outDir, `connection-en-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#modal').isHidden(), true);
    await page.screenshot({ path: join(outDir, `subscriptions-en-${width}.png`), fullPage: true });
  }
  await page.locator('#locale').selectOption('zh');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: join(outDir, 'subscriptions-zh-390.png'), fullPage: true });
  await row('zenmux').getByRole('button', { name: '连接配置', exact: true }).click();
  await page.screenshot({ path: join(outDir, 'connection-zh-390.png') });
  await page.keyboard.press('Escape');
  await page.locator('#locale').selectOption('en');
  completed.push('390px and 320px layouts in both locales; modal focus trap, Escape and reduced-motion environment');

  await page.reload();
  await page.getByText('OAuth authentication', { exact: true }).waitFor();
  assert.equal(await page.locator('#locale').inputValue(), 'en');
  completed.push('Locale preference persists independently of authorization');

  await row('new-api').getByRole('button', { name: 'Connect key', exact: true }).click();
  await page.locator('#connection-access').fill('mock-custom-gateway-key');
  await page.locator('#connection-baseURL').fill('http://api.example.test/v1');
  await page.getByRole('button', { name: 'Save and connect', exact: true }).click();
  await page.getByText('Enter an HTTPS API URL without credentials, query parameters or a fragment.', { exact: true }).waitFor();
  await page.locator('#connection-baseURL').fill('https://api.example.test/v1');
  await page.getByRole('button', { name: 'Save and connect', exact: true }).click();
  await row('new-api').getByText('Connected', { exact: true }).waitFor();
  assert.equal(calls.filter((call) => call.pathname.endsWith('/connect')).at(-1).body.baseURL, 'https://api.example.test/v1');
  completed.push('New API requires explicit HTTPS API root and stores it only for that provider');

  const startPage = await context.newPage();
  await startPage.goto(`${origin}/oauth/auth.html?provider=anthropic&locale=en`);
  await startPage.getByText('Starting Claude Pro/Max sign-in', { exact: true }).waitFor();
  await startPage.close();
  completed.push('Authorization startup page follows selected locale');

  await page.setViewportSize({ width: 1280, height: 900 });
  usageMode = 'late';
  const waiting = new Promise((resolve) => { lateUsage = resolve; });
  await row('zenmux').getByRole('button', { name: 'Plan & usage', exact: true }).click();
  await waiting;
  await row('zenmux').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByText(/same shared credential/).waitFor();
  await page.locator('#confirm-disconnect').click();
  await row('zenmux').getByRole('button', { name: 'Connect key', exact: true }).waitFor();
  releaseLate();
  await page.waitForTimeout(120);
  assert.equal(await row('zenmux').locator('[data-usage-panel]').count(), 0);
  completed.push('Late quota response cannot restore data after disconnect; shared credential impact is explicit');

  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  assert.ok(!stored.includes('mock-management-secret') && !stored.includes('mock-inference-secret'));
  assert.ok(!calls.some((call) => /chat\/completions|generate|messages/.test(call.pathname)));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, []);
  completed.push('No credential persistence in browser, no inference requests, no browser errors or external network');
  await writeFile(join(outDir, 'report.json'), JSON.stringify({ passed: completed.length, completed, pageErrors, blockedRequests, endpoints: [...new Set(calls.map((call) => call.pathname))] }, null, 2));
  process.stdout.write(JSON.stringify({ passed: completed.length, outDir, completed }, null, 2) + '\n');
} finally {
  releaseLate?.();
  await context.close(); await browser.close(); await new Promise((resolve) => server.close(resolve));
}
