import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderDefinition, providerDefinitions } from './catalog.js';
import { aggregatorUsageIds } from './usage/aggregators.js';
import { officialUsageIds } from './usage/official.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

test('catalog covers all quota adapters plus explicit model-only and gateway connections', () => {
  const ids = providerDefinitions.map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [...aggregatorUsageIds, ...officialUsageIds, 'qwen', 'deepseek', 'new-api']) assert.ok(ids.includes(id), id);
  assert.equal(getProviderDefinition('__proto__'), undefined);
  assert.equal(getProviderDefinition('unknown'), undefined);
});

test('fixed supplier endpoints ignore arbitrary metadata URL and request headers', () => {
  for (const source of providerDefinitions.filter(row => row.id !== 'new-api')) {
    const normal = getProviderDefinition(source.id);
    const row = getProviderDefinition(source.id, { baseURL: 'https://evil.example', apiBase: 'https://evil.example', modelsURL: 'https://evil.example/models', requestHeaders: { Authorization: 'secret' }, access: 'secret', billingAccess: 'billing-secret' });
    assert.equal(row.baseURL, normal.baseURL);
    assert.equal(row.modelsURL, normal.modelsURL);
    assert.deepEqual(row.usageHosts, normal.usageHosts);
    assert.equal(JSON.stringify(row).includes('secret'), false);
  }
});

test('region-bound endpoints and usage hosts stay paired without cross-region probing', () => {
  for (const id of ['kimi-coding', 'minimax', 'zai', 'aliyun-token-plan']) {
    const cn = getProviderDefinition(id, { region: 'cn' });
    const global = getProviderDefinition(id, { region: 'global' });
    assert.notEqual(cn.baseURL, global.baseURL, id);
    assert.notDeepEqual(cn.usageHosts, global.usageHosts, id);
    for (const region of ['moon', '__proto__', 'constructor']) {
      const invalid = getProviderDefinition(id, { region });
      assert.equal(invalid.keyConnect, false);
      assert.equal(invalid.baseURL, undefined);
      assert.equal(invalid.modelsURL, undefined);
      assert.deepEqual(invalid.usageHosts, []);
    }
  }
  assert.equal(getProviderDefinition('kimi-coding', { region: 'cn' }).modelsURL, 'https://api.kimi.com/coding/v1/models');
  assert.equal(getProviderDefinition('kimi-coding', { region: 'global' }).modelsURL, 'https://api.kimi.ai/coding/v1/models');
});

test('unverified model listing and unsupported Google login are explicit', () => {
  for (const id of ['minimax', 'zai', 'aliyun-token-plan']) {
    const row = getProviderDefinition(id, { region: 'cn' });
    assert.equal(row.modelsURL, undefined);
    assert.equal(row.reason, 'installed-catalog-only');
    assert.ok(row.catalogProvider);
    assert.equal(row.entitlement, 'unknown');
  }
  for (const id of ['google-antigravity', 'google-gemini-cli']) {
    const row = getProviderDefinition(id);
    assert.equal(row.keyConnect, false);
    assert.equal(row.modelsURL, undefined);
    assert.equal(row.reason, id === 'google-gemini-cli' ? 'gemini-consumer-retired' : 'host-oauth-model-integration-unavailable');
  }
  const internationalAli = getProviderDefinition('aliyun-token-plan');
  assert.equal(internationalAli.keyConnect, true);
  assert.equal(internationalAli.baseURL, 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(internationalAli.catalogProvider, 'qwen-token-plan-individual');
});

test('installed catalog mappings use the actual provider protocol and base URL', () => {
  const catalog = builtinModels();
  for (const id of ['minimax', 'zai', 'aliyun-token-plan']) for (const region of ['cn', 'global']) {
    const definition = getProviderDefinition(id, { region });
    const installed = catalog.getProvider(definition.catalogProvider);
    assert.ok(installed, definition.catalogProvider);
    assert.equal(definition.baseURL, installed.baseUrl);
    const models = catalog.getModels(definition.catalogProvider);
    assert.ok(models.length > 0);
    assert.ok(models.every(model => model.api === definition.api), `${id}/${region} protocol`);
    assert.equal(definition.entitlement, 'unknown');
  }
  assert.equal(getProviderDefinition('aliyun-token-plan', { region: 'global', planKind: 'team' }).catalogProvider, 'qwen-token-plan-individual');
  assert.equal(getProviderDefinition('minimax').keyAuth.header, 'x-api-key');
});

test('subscription, account-filtered and public catalogs preserve different entitlements', () => {
  const openrouter = getProviderDefinition('openrouter');
  assert.equal(openrouter.modelsURL, 'https://openrouter.ai/api/v1/models/user');
  assert.equal(openrouter.modelSource, 'account');
  const nano = getProviderDefinition('nanogpt');
  assert.equal(nano.entitlement, 'subscription');
  assert.equal(nano.baseURL, 'https://api.nano-gpt.com/api/subscription/v1');
  assert.equal(nano.modelsURL, 'https://api.nano-gpt.com/api/subscription/v1/models?detailed=true');
  assert.equal(getProviderDefinition('nous').modelSource, 'account');
  for (const id of ['zenmux', 'poe', 'kilo', 'synthetic', 'chutes']) {
    assert.equal(getProviderDefinition(id).modelSource, 'catalog');
    assert.equal(getProviderDefinition(id).entitlement, 'unknown');
  }
});

test('scope headers are explicitly selected and never copied from arbitrary metadata', () => {
  assert.equal(getProviderDefinition('openai-codex', { accountId: 'account_123' }).modelHeaders['chatgpt-account-id'], 'account_123');
  assert.equal(getProviderDefinition('kilo', { organizationId: 'org_123' }).modelHeaders['X-KiloCode-OrganizationId'], 'org_123');
  assert.equal(getProviderDefinition('opencode-go', { workspaceId: 'workspace_1' }).modelHeaders['x-opencode-org-id'], 'workspace_1');
  assert.equal(getProviderDefinition('opencode-go', { workspaceId: 'workspace_1' }).routeHeaders['x-opencode-org-id'], 'workspace_1');
  assert.equal(getProviderDefinition('kilo', { organizationId: 'org_123' }).routeHeaders['X-KiloCode-OrganizationId'], 'org_123');
  assert.equal(getProviderDefinition('kimi-coding').routeHeaders['user-agent'], 'KimiCLI/1.0');
  assert.equal(getProviderDefinition('openai-codex', { accountId: 'value\nheader' }).modelHeaders['chatgpt-account-id'], undefined);
  assert.equal(getProviderDefinition('kilo', { organizationId: 'value\nheader' }).modelHeaders['X-KiloCode-OrganizationId'], undefined);
});

test('definitions and independent resolutions cannot mutate shared policy', () => {
  assert.equal(Object.isFrozen(providerDefinitions), true);
  assert.equal(Object.isFrozen(providerDefinitions[0].usageHosts), true);
  const first = getProviderDefinition('kimi-coding', { region: 'cn' });
  first.usageHosts.push('evil.example');
  first.modelHeaders.Accept = 'text/plain';
  first.keyAuth.header = 'Cookie';
  const second = getProviderDefinition('kimi-coding', { region: 'cn' });
  assert.deepEqual(second.usageHosts, ['api.kimi.com']);
  assert.equal(second.modelHeaders.Accept, 'application/json');
  assert.equal(second.keyAuth.header, 'Authorization');
});

test('custom gateway is opt-in, issuer-bound and requires an explicit public HTTPS base', () => {
  assert.equal(getProviderDefinition('new-api').keyConnect, false);
  for (const baseURL of ['http://gateway.example/v1', 'https://user:secret@gateway.example/v1', 'https://gateway.example/v1?key=secret', 'https://gateway.example/v1#secret', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://169.254.169.254/v1', 'https://service.internal/v1', 'https://service.local/v1', 'https://gateway.example:444/v1']) {
    const row = getProviderDefinition('new-api', { baseURL });
    assert.equal(row.keyConnect, false, baseURL);
    assert.equal(row.modelsURL, undefined);
    assert.deepEqual(row.usageHosts, []);
  }
  const row = getProviderDefinition('new-api', { baseURL: 'https://gateway.example/v1/' });
  assert.equal(row.keyConnect, true);
  assert.equal(row.baseURL, 'https://gateway.example/v1');
  assert.equal(row.modelsURL, 'https://gateway.example/v1/models');
  assert.deepEqual(row.usageHosts, ['gateway.example']);
  assert.equal(row.entitlement, 'unknown');
});

test('all built-in URLs are HTTPS and never include credentials or mutable caller domains', () => {
  for (const row of providerDefinitions) {
    for (const value of [row.baseURL, row.modelsURL].filter(Boolean)) {
      const url = new URL(value);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.username, '');
      assert.equal(url.password, '');
    }
    for (const host of row.usageHosts) assert.match(host, /^[a-z0-9.-]+$/);
  }
});
