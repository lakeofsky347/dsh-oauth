import { isIP } from 'node:net';

// Fixed supplier endpoints verified against the official contracts recorded in
// the 2026-11-16 quota research. A model catalog is not a funding guarantee.
const bearerKey = Object.freeze({ header: 'Authorization', scheme: 'Bearer' });
const definitions = [
  { id: 'openai-codex', name: 'ChatGPT / Codex', group: 'official', keyConnect: false,
    baseURL: 'https://chatgpt.com/backend-api/codex',
    modelsURL: 'https://chatgpt.com/backend-api/codex/models',
    modelSource: 'account', entitlement: 'account', usageHosts: ['chatgpt.com'] },
  { id: 'anthropic', name: 'Claude API', group: 'official', keyConnect: true, oauthConnect: false,
    baseURL: 'https://api.anthropic.com', modelsURL: 'https://api.anthropic.com/v1/models?limit=1000',
    modelHeaders: { 'anthropic-version': '2023-06-01' }, docs: 'https://platform.claude.com/docs/en/api/models/list',
    modelSource: 'account', entitlement: 'account', usageHosts: [] },
  { id: 'github-copilot', name: 'GitHub Copilot', group: 'official', keyConnect: false,
    baseURL: 'https://api.individual.githubcopilot.com', modelsURL: 'https://api.individual.githubcopilot.com/models',
    modelHeaders: { 'user-agent': 'GitHubCopilotChat/0.35.0', 'editor-version': 'vscode/1.107.0', 'editor-plugin-version': 'copilot-chat/0.35.0', 'copilot-integration-id': 'vscode-chat', 'x-github-api-version': '2026-06-01' },
    modelSource: 'account', entitlement: 'account', usageHosts: ['api.github.com'] },
  { id: 'kimi-coding', name: 'Kimi Code', group: 'official', keyConnect: true,
    modelHeaders: { 'user-agent': 'KimiCLI/1.0' }, modelSource: 'account', entitlement: 'account',
    regions: {
      global: { baseURL: 'https://api.kimi.ai/coding/v1', modelsURL: 'https://api.kimi.ai/coding/v1/models', usageHosts: ['api.kimi.ai'] },
      cn: { baseURL: 'https://api.kimi.com/coding/v1', modelsURL: 'https://api.kimi.com/coding/v1/models', usageHosts: ['api.kimi.com'] },
    } },
  { id: 'minimax', name: 'MiniMax', group: 'official', keyConnect: true,
    modelSource: 'catalog', entitlement: 'unknown', reason: 'installed-catalog-only', api: 'anthropic-messages',
    regions: {
      global: { baseURL: 'https://api.minimax.io/anthropic', catalogProvider: 'minimax', usageHosts: ['api.minimax.io'] },
      cn: { baseURL: 'https://api.minimaxi.com/anthropic', catalogProvider: 'minimax-cn', usageHosts: ['api.minimax.cn'] },
    } },
  { id: 'zai', name: 'Z.AI / GLM Coding Plan', group: 'official', keyConnect: true,
    modelSource: 'catalog', entitlement: 'unknown', reason: 'installed-catalog-only',
    regions: {
      global: { baseURL: 'https://api.z.ai/api/coding/paas/v4', catalogProvider: 'zai', usageHosts: ['api.z.ai'] },
      cn: { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', catalogProvider: 'zai-coding-cn', usageHosts: ['bigmodel.cn'] },
    } },
  // https://help.aliyun.com/en/model-studio/base-url: new Token Plan and
  // legacy Coding Plan use different keys and domains. Never use PAYG as fallback.
  { id: 'aliyun-token-plan', name: 'Alibaba Cloud Token Plan', group: 'official', keyConnect: true,
    modelSource: 'catalog', entitlement: 'unknown', reason: 'installed-catalog-only',
    regions: {
      cn: { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', catalogProvider: 'qwen-token-plan-cn', usageHosts: ['bailian-cs.console.aliyun.com'] },
      global: { baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', catalogProvider: 'qwen-token-plan-individual', usageHosts: ['bailian-singapore-cs.alibabacloud.com'] },
    } },
  { id: 'google-antigravity', name: 'Google Antigravity', group: 'official', keyConnect: false,
    modelSource: 'account', entitlement: 'unknown', usageHosts: ['daily-cloudcode-pa.googleapis.com'], reason: 'host-oauth-model-integration-unavailable',
    docs: 'https://antigravity.google/docs/cli/commands/usage' },
  { id: 'google-gemini-cli', name: 'Google Gemini CLI', group: 'official', keyConnect: false,
    modelSource: 'account', entitlement: 'unknown', usageHosts: ['cloudcode-pa.googleapis.com'], reason: 'gemini-consumer-retired',
    docs: 'https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals' },
  { id: 'xai', name: 'xAI Grok', group: 'official', keyConnect: false,
    baseURL: 'https://cli-chat-proxy.grok.com/v1', modelsURL: 'https://cli-chat-proxy.grok.com/v1/models',
    modelHeaders: { 'x-xai-token-auth': 'xai-grok-cli' }, modelSource: 'account', entitlement: 'account', usageHosts: ['cli-chat-proxy.grok.com'] },
  // Authenticated /v1/models is the org's reachability allowlist in Hermes:
  // NousResearch/hermes-agent@f8acc268.../hermes_cli/models_pricing.py.
  { id: 'nous', name: 'Nous Portal', group: 'aggregator', keyConnect: true,
    baseURL: 'https://inference-api.nousresearch.com/v1', modelsURL: 'https://inference-api.nousresearch.com/v1/models',
    modelSource: 'account', entitlement: 'account', usageHosts: ['portal.nousresearch.com'], reason: 'usage-requires-portal-oauth' },
  { id: 'qwen', name: 'Qwen Code subscription', group: 'official', keyConnect: false,
    baseURL: 'https://api.qwen.ai/compatible-mode/v1', modelsURL: 'https://api.qwen.ai/compatible-mode/v1/models',
    modelSource: 'account', entitlement: 'account', usageHosts: [], reason: 'qwen-legacy-oauth',
    docs: 'https://help.aliyun.com/en/model-studio/qwen-code' },
  { id: 'deepseek', name: 'DeepSeek API', group: 'official', keyConnect: true,
    baseURL: 'https://api.deepseek.com', modelsURL: 'https://api.deepseek.com/models',
    modelSource: 'catalog', entitlement: 'unknown', usageHosts: ['api.deepseek.com'] },
  { id: 'openrouter', name: 'OpenRouter', group: 'aggregator', keyConnect: true,
    baseURL: 'https://openrouter.ai/api/v1', modelsURL: 'https://openrouter.ai/api/v1/models/user',
    modelSource: 'account', entitlement: 'account', usageHosts: ['openrouter.ai'] },
  // NanoGPT's total /api/v1/models catalog is deliberately not substituted for
  // the subscription-specific list, and inference uses the matching channel.
  { id: 'nanogpt', name: 'NanoGPT', group: 'aggregator', keyConnect: true,
    baseURL: 'https://api.nano-gpt.com/api/subscription/v1', modelsURL: 'https://api.nano-gpt.com/api/subscription/v1/models?detailed=true',
    modelSource: 'catalog', entitlement: 'subscription', usageHosts: ['api.nano-gpt.com', 'nano-gpt.com'] },
  { id: 'zenmux', name: 'ZenMux', group: 'aggregator', keyConnect: true,
    baseURL: 'https://zenmux.ai/api/v1', modelsURL: 'https://zenmux.ai/api/v1/models',
    modelSource: 'catalog', entitlement: 'unknown', usageHosts: ['zenmux.ai'] },
  { id: 'opencode-go', name: 'OpenCode Go', group: 'aggregator', keyConnect: true,
    baseURL: 'https://opencode.ai/inference/go/v1', modelsURL: 'https://opencode.ai/inference/go/v1/models',
    modelSource: 'catalog', entitlement: 'subscription', usageHosts: ['opencode.ai'] },
  { id: 'opencode-zen', name: 'OpenCode Console / Zen', group: 'aggregator', keyConnect: true,
    baseURL: 'https://opencode.ai/inference/v1', modelsURL: 'https://opencode.ai/inference/v1/models',
    modelSource: 'catalog', entitlement: 'unknown', usageHosts: ['opencode.ai'] },
  { id: 'kilo', name: 'Kilo Gateway / Pass', group: 'aggregator', keyConnect: true,
    baseURL: 'https://ai-gateway.kilo.ai/api/v1', modelsURL: 'https://ai-gateway.kilo.ai/api/v1/models',
    modelSource: 'catalog', entitlement: 'unknown', usageHosts: ['app.kilo.ai'] },
  { id: 'poe', name: 'Poe', group: 'aggregator', keyConnect: true,
    baseURL: 'https://api.poe.com/v1', modelsURL: 'https://api.poe.com/v1/models',
    modelSource: 'catalog', entitlement: 'unknown', usageHosts: ['api.poe.com'] },
  { id: 'synthetic', name: 'Synthetic', group: 'aggregator', keyConnect: true,
    baseURL: 'https://api.synthetic.new/openai/v1', modelsURL: 'https://api.synthetic.new/openai/v1/models',
    modelSource: 'catalog', entitlement: 'unknown', usageHosts: ['api.synthetic.new'] },
  { id: 'chutes', name: 'Chutes', group: 'aggregator', keyConnect: true,
    baseURL: 'https://llm.chutes.ai/v1', modelsURL: 'https://llm.chutes.ai/v1/models',
    modelSource: 'catalog', entitlement: 'unknown', usageHosts: ['api.chutes.ai'] },
  { id: 'new-api', name: 'New API gateway', group: 'gateway', keyConnect: false,
    modelSource: 'catalog', entitlement: 'unknown', usageHosts: [], reason: 'instance-url-required' },
];

const byId = new Map(definitions.map(definition => [definition.id, definition]));
const safeScope = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined;

function gatewayBase(value) {
  if (typeof value !== 'string' || value.length > 2048 || /\s/.test(value)) return undefined;
  let url;
  try { url = new URL(value); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  // A custom gateway must be an explicit public HTTPS instance. Local callback,
  // metadata-service and LAN addresses are not automatic credential targets.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443'
    || !host.includes('.') || host.endsWith('.') || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || isIP(host.replace(/^\[|\]$/g, ''))) return undefined;
  return url.toString().replace(/\/+$/, '');
}

/** Endpoint and capability metadata only. This function never handles secrets. */
export function getProviderDefinition(id, metadata = {}) {
  const source = byId.get(id);
  if (!source) return undefined;
  metadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const { regions, ...base } = source;
  const region = metadata.region ?? 'global';
  const regional = regions && typeof region === 'string' && Object.hasOwn(regions, region) ? regions[region] : undefined;
  const out = {
    api: 'openai-completions', ...base, ...(regional ?? {}),
    modelHeaders: { Accept: 'application/json', ...source.modelHeaders },
    routeHeaders: {},
    usageHosts: [...(regional?.usageHosts ?? source.usageHosts ?? [])],
    ...(source.keyConnect ? { keyAuth: { ...bearerKey } } : {}),
  };
  if (regions) {
    out.region = region;
    out.regions = Object.keys(regions);
    if (!regional) {
      out.keyConnect = false;
      delete out.baseURL; delete out.modelsURL;
      out.usageHosts = [];
      out.reason = 'unsupported-region';
    }
  }
  if (id === 'openai-codex') {
    out.api = 'openai-codex-responses';
    const accountId = safeScope(metadata.accountId);
    if (accountId) out.modelHeaders['chatgpt-account-id'] = accountId;
  }
  if (id === 'anthropic') out.api = 'anthropic-messages';
  if (id === 'kimi-coding') out.routeHeaders['user-agent'] = 'KimiCLI/1.0';
  if (out.api === 'anthropic-messages' && out.keyConnect) out.keyAuth = { header: 'x-api-key' };
  if (id === 'opencode-go' || id === 'opencode-zen') {
    const org = safeScope(metadata.workspaceId) || safeScope(metadata.organizationId);
    if (org) { out.modelHeaders['x-opencode-org-id'] = org; out.routeHeaders['x-opencode-org-id'] = org; }
  }
  if (id === 'kilo') {
    const org = safeScope(metadata.organizationId);
    if (org) { out.modelHeaders['X-KiloCode-OrganizationId'] = org; out.routeHeaders['X-KiloCode-OrganizationId'] = org; }
  }
  if (id === 'new-api') {
    const baseURL = gatewayBase(metadata.baseURL);
    if (baseURL) {
      out.baseURL = baseURL;
      out.modelsURL = `${baseURL}/models`;
      out.usageHosts = [new URL(baseURL).hostname];
      out.keyConnect = true;
      out.keyAuth = { ...bearerKey };
      delete out.reason;
    }
  }
  if (!out.keyConnect) delete out.keyAuth;
  return out;
}

// Safe for UI enumeration: contains no tokens, imported config or mutable arrays.
export const providerDefinitions = Object.freeze(definitions.map(({ id }) => {
  const row = getProviderDefinition(id);
  Object.freeze(row.usageHosts);
  Object.freeze(row.modelHeaders);
  Object.freeze(row.routeHeaders);
  if (row.keyAuth) Object.freeze(row.keyAuth);
  if (row.regions) Object.freeze(row.regions);
  return Object.freeze(row);
}));
