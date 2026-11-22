import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const MAX_BYTES = 1024 * 1024;
const NEAR_EXPIRY_MS = 60_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const providerID = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value);
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 262144 && !/[\x00-\x20\x7f]/.test(value) ? value : undefined;
const labels = Object.freeze({ codex: 'Codex CLI', opencode: 'OpenCode CLI' });
const exec = promisify(execFile);

export class LocalSourceError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalSourceError'; this.code = code; }
}
const error = (code, message) => new LocalSourceError(code, message);
const AGY_PROVIDER = 'google-antigravity';
const AGY_REASON = 'source-does-not-export-credentials';

function defaultCodexHome(home = homedir()) {
  const codexHome = process.env.CODEX_HOME;
  return codexHome && isAbsolute(codexHome) ? codexHome : join(home, '.codex');
}

function expiryFromJWT(value) {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[1].length > 32768) return undefined;
  try {
    // Only a lifetime hint; unsigned JWT claims never establish identity or permission.
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) && payload.exp > 0 && payload.exp <= 8.64e12 ? payload.exp * 1000 : undefined;
  } catch { return undefined; }
}

function oauth(access, expires, accountId, now) {
  access = secret(access);
  if (!access) throw error('invalid-source', 'The CLI source does not contain a usable OAuth access token.');
  const explicitExpiry = typeof expires === 'number' && Number.isFinite(expires) && expires > 0 && expires <= 8.64e15 ? expires : undefined;
  const expiry = explicitExpiry ?? expiryFromJWT(access);
  if (expiry !== undefined && expiry <= now + NEAR_EXPIRY_MS) throw error('source-reauth-required', 'The source CLI authorization has expired or is about to expire. Sign in or refresh it in that CLI, then retry.');
  const grant = { type: 'oauth', access };
  if (expiry !== undefined) grant.expires = expiry;
  if (typeof accountId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(accountId)) grant.accountId = accountId;
  return grant;
}

function apiKey(value) {
  const access = secret(value);
  if (!access) throw error('invalid-source', 'The CLI source does not contain a usable API key.');
  return { type: 'api_key', access };
}

function codexEntries(data, now) {
  if (!object(data)) throw error('invalid-source', 'The Codex authorization file has an unsupported format.');
  if (data.auth_mode === 'apikey' || (secret(data.OPENAI_API_KEY) && !object(data.tokens))) {
    return [{ provider: 'openai', authType: 'api-key', grant: () => apiKey(data.OPENAI_API_KEY) }];
  }
  if (data.auth_mode && !['chatgpt', 'chatgptAuthTokens'].includes(data.auth_mode)) throw error('unsupported-source', 'This Codex authorization mode is not supported.');
  if (!object(data.tokens)) throw error('invalid-source', 'The Codex authorization file has no supported token entry.');
  return [{ provider: 'openai-codex', authType: 'oauth', grant: () => oauth(data.tokens.access_token, undefined, data.tokens.account_id, now) }];
}

function openCodeEntries(data, now) {
  if (!object(data)) throw error('invalid-source', 'The OpenCode authorization file has an unsupported format.');
  // This is the legacy dictionary contract, not current SQLite or an export-array guess.
  const entries = [];
  const secrets = Object.values(data).filter(object).flatMap(value => [value.access, value.refresh, value.key, value.token, value.id_token]).filter(value => typeof value === 'string' && value.length);
  for (const [sourceProvider, value] of Object.entries(data).slice(0, 200)) {
    if (!providerID(sourceProvider) || !object(value)) continue;
    if (secrets.some(value => sourceProvider === value || value.length >= 8 && sourceProvider.includes(value))) continue;
    if (value.type === 'oauth') {
      const provider = sourceProvider === 'openai' ? 'openai-codex' : sourceProvider;
      entries.push({ provider, authType: 'oauth', grant: () => oauth(value.access, value.expires, value.accountId ?? value.account_id, now) });
    } else if (value.type === 'api' || value.type === 'api_key') {
      // API keys keep their true source provider. A brand key is not proof of a Coding Plan.
      entries.push({ provider: sourceProvider, authType: 'api-key', grant: () => apiKey(value.key ?? value.access) });
    }
  }
  if (!entries.length) throw error('unsupported-source', 'No supported OAuth or API-key entries were found in the OpenCode auth.json source.');
  return entries;
}

function openCodeProvider(id, type) {
  return id === 'openai' && type === 'oauth' ? 'openai-codex' : id;
}

async function openCodeCommand(args) {
  const configured = process.env.DSH_OAUTH_OPENCODE_BIN;
  const options = { cwd: homedir(), timeout: 8000, maxBuffer: MAX_BYTES, windowsHide: true,
    env: { ...process.env, OPENCODE_DISABLE_EXTERNAL_PLUGINS: 'true' } };
  if (configured && isAbsolute(configured)) return (await exec(configured, args, options)).stdout;
  try { return (await exec('opencode', args, options)).stdout; }
  catch (cause) {
    if (cause.code !== 'ENOENT' || process.platform !== 'darwin') throw cause;
    const prefix = process.arch === 'arm64' ? '/opt/homebrew' : '/usr/local';
    return (await exec(join(prefix, 'bin', 'opencode'), args, options)).stdout;
  }
}

async function openCodeV2(run) {
  if (!run) return false;
  try { return /^(?:opencode\s+)?(?:[2-9]|\d{2,})\.\d+\.\d+(?:[-+][\w.+-]+)?$/i.test((await run(['--version'])).trim()); }
  catch { return false; }
}

async function openCodeJson(run, args) {
  try {
    const rows = JSON.parse(await run(args));
    if (!Array.isArray(rows)) throw new Error('Unexpected result');
    return rows;
  } catch { throw error('source-unavailable', 'The OpenCode v2 CLI did not return usable authorization data.'); }
}

async function listOpenCodeV2(run) {
  const rows = await openCodeJson(run, ['auth', 'list', '--format', 'json']);
  const choices = new Map();
  for (const row of rows) {
    if (!providerID(row?.id) || !Array.isArray(row.connections)) continue;
    const supported = row.connections.filter(item => item?.type === 'credential' && ['key', 'oauth'].includes(item.method));
    for (const item of supported) {
      const provider = openCodeProvider(row.id, item.method);
      const reasonCode = item.status?.status === 'needs_auth' ? 'source-reauth-required' : undefined;
      const previous = choices.get(provider);
      choices.set(provider, { provider, authType: item.method === 'oauth' ? 'oauth' : 'api-key',
        available: !previous && !reasonCode, ...(previous ? { reasonCode: 'ambiguous-source' } : reasonCode ? { reasonCode } : {}) });
    }
  }
  return [...choices.values()];
}

async function readOpenCodeV2(run, provider, now) {
  const id = provider === 'openai-codex' ? 'openai' : provider;
  const rows = await openCodeJson(run, ['auth', 'export', id]);
  const matches = rows.filter(row => row?.integrationID === id && object(row.value) &&
    ['oauth', 'key'].includes(row.value.type) && openCodeProvider(id, row.value.type) === provider);
  const active = matches.filter(row => row.active === true);
  const selected = active.length ? active : matches;
  if (!selected.length) throw error('source-unavailable', 'OpenCode v2 has no supported stored credential for this provider.');
  if (selected.length !== 1) throw error('ambiguous-source', 'OpenCode v2 returned several accounts without an unambiguous active credential.');
  const value = selected[0].value;
  return value.type === 'key' ? apiKey(value.key) : oauth(value.access, value.expires, value.metadata?.accountId ?? value.metadata?.account_id, now);
}

async function readKnownJSON(path, maxBytes = MAX_BYTES) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw error('invalid-source', 'The CLI authorization source is not a bounded regular JSON file.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > stat.size) throw error('invalid-source', 'The CLI authorization source changed while being read.');
    try { return JSON.parse(buffer.subarray(0, total).toString('utf8')); }
    catch { throw error('invalid-source', 'The CLI authorization source is not valid JSON.'); }
  } catch (cause) {
    if (cause instanceof LocalSourceError) throw cause;
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') throw error('source-unavailable', 'The selected CLI authorization source is not available.');
    throw error('source-unavailable', 'The selected CLI authorization source cannot be read.');
  } finally { await handle?.close().catch(() => {}); }
}

/** Read only version metadata from the cache. Its catalog can belong to a different account. */
export async function readCodexCatalogClientVersion() {
  try {
    const cache = await readKnownJSON(join(defaultCodexHome(), 'models_cache.json'), 4 * MAX_BYTES);
    return cache?.client_version;
  } catch {
    return undefined;
  }
}

/** Ask the official CLI for its account catalog, without exporting its keyring credentials. */
export async function fetchAntigravityCliModels() {
  const binary = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  const options = { cwd: tmpdir(), timeout: 15000, maxBuffer: MAX_BYTES, windowsHide: true,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } };
  try {
    let result;
    try { result = await exec(binary, ['models'], options); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      result = await exec('agy', ['models'], options);
    }
    const models = new Map();
    for (const line of result.stdout.split(/\r?\n/)) {
      const [id, name] = line.split('\t');
      if (providerID(id) && name?.trim()) models.set(id, { id, name: name.trim().slice(0, 160), role: 'chat' });
    }
    if (models.size) return [...models.values()];
  } catch {
    // Child errors may include CLI logs or login links and must stay local.
  }
  throw error('source-unavailable', '无法从 AGY 读取模型目录。请确认宿主可运行 agy models，并在 AGY 中完成登录。');
}

/** Roots are trusted server configuration only. HTTP bodies must never reach this factory. */
export function createLocalSources({ home = homedir(), codexHome, openCodeDataHome, runOpenCode, now = () => Date.now() } = {}) {
  if (!isAbsolute(home) || codexHome !== undefined && !isAbsolute(codexHome) || openCodeDataHome !== undefined && !isAbsolute(openCodeDataHome)) throw error('invalid-configuration', 'CLI source roots must be absolute server-configured directories.');
  const sources = {
    codex: { path: join(codexHome ?? join(home, '.codex'), 'auth.json'), parse: codexEntries },
    opencode: { path: join(openCodeDataHome ?? join(home, '.local', 'share'), 'opencode', 'auth.json'), parse: openCodeEntries },
  };
  async function entries(source) {
    if (typeof source !== 'string' || !Object.hasOwn(sources, source)) throw error('unsupported-source', 'The selected CLI source is not supported.');
    const spec = sources[source];
    return spec.parse(await readKnownJSON(spec.path), now());
  }
  async function discoverLocalSources() {
    const fileSources = await Promise.all(Object.keys(sources).map(async id => {
      try {
        if (id === 'opencode' && await openCodeV2(runOpenCode)) {
          const providers = await listOpenCodeV2(runOpenCode);
          return { id, label: labels[id], available: providers.some(item => item.available), providers };
        }
        const list = await entries(id);
        const counts = new Map();
        for (const item of list) counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
        const providers = [...new Map(list.map(item => {
          let reasonCode;
          if (counts.get(item.provider) > 1) reasonCode = 'ambiguous-source';
          else try { item.grant(); } catch (cause) { reasonCode = cause instanceof LocalSourceError ? cause.code : 'invalid-source'; }
          return [item.provider, { provider: item.provider, authType: item.authType, available: reasonCode === undefined, ...(reasonCode ? { reasonCode } : {}) }];
        })).values()];
        return { id, label: labels[id], available: providers.some(item => item.available), providers };
      } catch (cause) {
        return { id, label: labels[id], available: false, reasonCode: cause instanceof LocalSourceError ? cause.code : 'invalid-source', providers: [] };
      }
    }));
    return [...fileSources, { id: 'agy', label: 'Antigravity CLI (agy)', available: false, reasonCode: AGY_REASON,
      providers: [{ provider: AGY_PROVIDER, authType: 'oauth', available: false, reasonCode: AGY_REASON }] }];
  }
  async function readLocalSource(source, provider) {
    if (!providerID(provider)) throw error('unsupported-provider', 'The selected source provider is not supported.');
    if (source === 'agy' && provider === AGY_PROVIDER) {
      throw error(AGY_REASON, 'Antigravity CLI manages its login in the system keyring and does not export reusable credentials. Use /usage in agy to view subscription quota.');
    }
    if (source === 'opencode' && await openCodeV2(runOpenCode)) {
      return { provider, grant: await readOpenCodeV2(runOpenCode, provider, now()), owner: 'external-managed', source: { id: source, provider }, label: labels[source] };
    }
    // Reread the same fixed source on every use: no cached token or refresh chain survives source logout.
    const matches = (await entries(source)).filter(item => item.provider === provider);
    if (!matches.length) throw error('source-unavailable', 'The selected provider is no longer present in the source CLI.');
    if (matches.length > 1) throw error('ambiguous-source', 'Multiple source entries map to this provider. Select one in the source CLI before connecting.');
    return { provider, grant: matches[0].grant(), owner: 'external-managed', source: { id: source, provider }, label: labels[source] };
  }
  return { discoverLocalSources, readLocalSource };
}

const defaults = createLocalSources({
  codexHome: defaultCodexHome(),
  openCodeDataHome: process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : undefined,
  runOpenCode: openCodeCommand,
});
export const discoverLocalSources = () => defaults.discoverLocalSources();
export const readLocalSource = (source, provider) => defaults.readLocalSource(source, provider);
