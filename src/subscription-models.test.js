import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { fetchAccountModels, modelListRequest, parseModelList, reasoningEffortsFrom, modelCompatFrom } from './models.js';
import { aggregatorUsageIds } from './usage/aggregators.js';
import { getProviderDefinition } from './catalog.js';

test('all nine aggregate catalogs retain capability metadata and explicit provenance', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: [{ id: 'vendor/agent-model', name: 'Agent Model', context_length: 200000, top_provider: { max_completion_tokens: 16384 }, architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'], supported_reasoning_levels: ['low', 'high'] }] }));
  });
  for (const id of aggregatorUsageIds) {
    const metadata = { access: 'fixture-model-key', organizationId: 'org_123', workspaceId: 'workspace_123' };
    const definition = getProviderDefinition(id, metadata);
    const [row] = await fetchAccountModels(id, metadata);
    assert.equal(row.source, definition.modelSource, id);
    assert.equal(row.entitlement, definition.entitlement, id);
    assert.equal(row.contextWindow, 200000);
    assert.equal(row.maxTokens, 16384);
    assert.deepEqual(row.input, ['text', 'image']);
    assert.deepEqual(row.output, ['text']);
    assert.deepEqual(row.reasoningEfforts, { low: 'low', high: 'high' });
    assert.equal(row.tools, true);
    assert.equal(row.role, 'chat');
    const request = requests.at(-1);
    assert.equal(request.url, definition.modelsURL);
    assert.equal(request.options.redirect, 'error');
    assert.equal(new Headers(request.options.headers).get('authorization'), 'Bearer fixture-model-key');
  }
  assert.equal(requests.length, 9);
});

test('NanoGPT detailed flags preserve vision and reasoning without inventing effort levels', () => {
  const [row] = parseModelList({ data: [{ id: 'vendor/model', description: 'Supports video input and speech-oriented tasks', context_length: 1000000, max_output_tokens: 128000, capabilities: { vision: true, video_input: true, reasoning: true, tool_calling: true, structured_output: true } }] }, 'nanogpt');
  assert.equal(row.role, 'chat');
  assert.deepEqual(row.input, ['text', 'image']);
  assert.equal(row.reasoning, true);
  assert.equal(row.reasoningEfforts, undefined);
  assert.equal(row.tools, true);
  assert.equal(row.output, undefined);
});

test('explicit output modality distinguishes Poe community media from video-understanding chat', () => {
  const rows = parseModelList({ data: [
    { id: 'community-picture-bot', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
    { id: 'community-animation', architecture: { output_modalities: ['video'] } },
    { id: 'community-voice', architecture: { output_modalities: ['audio'] } },
    { id: 'video-understanding', name: 'Video Understanding', architecture: { modality: 'text,image,video->text' } },
  ] }, 'poe');
  assert.deepEqual(rows.map(row => [row.id, row.role]), [['community-picture-bot', 'image'], ['community-animation', 'video'], ['video-understanding', 'chat']]);
  assert.deepEqual(rows[0].output, ['image']);
  assert.deepEqual(rows[1].output, ['video']);
  assert.deepEqual(rows[2].input, ['text', 'image']);
});

test('generic minimal catalog does not advertise missing tools, reasoning, or modalities', () => {
  const [row] = parseModelList({ data: [{ id: 'hf:vendor/model' }] }, 'synthetic');
  assert.equal(row.tools, undefined);
  assert.equal(row.reasoning, undefined);
  assert.equal(row.reasoningEfforts, undefined);
  assert.equal(row.input, undefined);
  assert.equal(row.output, undefined);
  assert.equal(row.contextWindow, undefined);
});

test('explicit false flags remain false and are not overridden by a generic feature name', () => {
  const [row] = parseModelList({ data: [{ id: 'plain', capabilities: { reasoning: false, tool_calling: false, vision: false }, supported_parameters: ['tools'] }] });
  assert.equal(row.tools, false);
  assert.equal(row.reasoning, false);
  assert.equal(row.reasoningEfforts, false);
  assert.deepEqual(row.input, ['text']);
});

test('installed reasoning maps preserve supported wire values and omit null levels', () => {
  const [row] = parseModelList([{ id: 'installed', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: 'max' } }]);
  assert.equal(row.reasoning, true);
  assert.deepEqual(row.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', max: 'max' });
  assert.equal(reasoningEffortsFrom({ supported_reasoning_levels: ['constructor', '__proto__', 'toString'] }), undefined);
});

test('DeepSeek documented effort metadata maps only advertised reasoning levels', () => {
  const [row] = parseModelList({ data: [{ id: 'deepseek-model', context_window: 1000000, max_output_tokens: 384000, input_modalities: ['text', 'image'], output_modalities: ['text'], effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] }, 'deepseek');
  assert.deepEqual(row.reasoningEfforts, { low: 'low', high: 'high', max: 'max' });
  assert.equal(row.contextWindow, 1000000);
  assert.equal(row.maxTokens, 384000);
});

test('installed MiniMax, ZAI and Alibaba model imports perform no remote request', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Installed catalog must not fetch or infer.'); });
  const registry = builtinModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  for (const provider of ['minimax', 'zai', 'aliyun-token-plan']) for (const region of ['cn', 'global']) {
    const definition = getProviderDefinition(provider, { region });
    const upstream = registry.getModels(definition.catalogProvider);
    const models = await fetchAccountModels(provider, { access: 'fixture-key', region });
    assert.equal(models.length, upstream.length);
    for (const model of models) {
      const installed = upstream.find(row => row.id === model.id);
      assert.ok(installed);
      assert.equal(model.source, 'installed-catalog');
      assert.equal(model.entitlement, 'unknown');
      assert.equal(model.reasoning, installed.reasoning);
      assert.equal(model.contextWindow, installed.contextWindow);
      assert.equal(model.maxTokens, installed.maxTokens);
      assert.deepEqual(model.input, installed.input);
      if (installed.compat) assert.deepEqual(model.compat, modelCompatFrom(installed.compat));
      if (installed.thinkingLevelMap) {
        const expected = Object.fromEntries(Object.entries(installed.thinkingLevelMap).filter(([, value]) => typeof value === 'string'));
        if (Object.keys(expected).length) assert.deepEqual(model.reasoningEfforts, expected);
      }
    }
  }
});

test('installed compat retains protocol settings but omits unsupported Harness fields', () => {
  assert.deepEqual(modelCompatFrom({ supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: true, thinkingFormat: 'qwen', maxTokensField: 'max_tokens', zaiToolStream: true, baseURL: 'https://evil.example', headers: { authorization: 'secret' } }), {
    supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: true, thinkingFormat: 'qwen', maxTokensField: 'max_tokens',
  });
  assert.deepEqual(modelCompatFrom({ chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled', omitWhenOff: true }, nested: { unsafe: 'not-supported' }, temperature: 0.1 }, thinkingFormat: 'unknown', supportsStore: 'yes' }), {
    chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled', omitWhenOff: true }, temperature: 0.1 },
  });
});

test('new aggregate credentials stay on pinned model hosts and cannot be overridden with extra headers', () => {
  for (const provider of aggregatorUsageIds) {
    const request = modelListRequest(provider, 'selected-key', { apiBase: 'https://evil.example', baseURL: 'https://evil.example', requestHeaders: { authorization: 'Bearer different-account', Cookie: 'session=other' } });
    assert.equal(request.url, getProviderDefinition(provider).modelsURL);
    assert.equal(new Headers(request.headers).get('authorization'), 'Bearer selected-key');
    assert.equal(new Headers(request.headers).get('cookie'), null);
  }
});

test('gateway catalog is bound to configured instance and unconfigured Google does not fabricate a list', () => {
  const request = modelListRequest('new-api', 'selected-key', { baseURL: 'https://gateway.example/v1' });
  assert.equal(request.url, 'https://gateway.example/v1/models');
  assert.throws(() => modelListRequest('new-api', 'key', { baseURL: 'http://127.0.0.1/v1' }), /目录接口/);
  assert.throws(() => modelListRequest('google-antigravity', 'key'), /目录接口/);
});
