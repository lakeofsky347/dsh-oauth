import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const NEAR_EXPIRY_MS = 60_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const providerID = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value);
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 262144 && !/[\x00-\x20\x7f]/.test(value) ? value : undefined;
const labels = Object.freeze({ codex: 'Codex CLI', opencode: 'OpenCode CLI (auth.json)' });

export class LocalSourceError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalSourceError'; this.code = code; }
}
const error = (code, message) => new LocalSourceError(code, message);

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

async function readKnownJSON(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw error('invalid-source', 'The CLI authorization source is not a bounded regular JSON file.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) throw error('invalid-source', 'The CLI authorization source exceeds the size limit.');
    try { return JSON.parse(buffer.subarray(0, total).toString('utf8')); }
    catch { throw error('invalid-source', 'The CLI authorization source is not valid JSON.'); }
  } catch (cause) {
    if (cause instanceof LocalSourceError) throw cause;
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') throw error('source-unavailable', 'The selected CLI authorization source is not available.');
    throw error('source-unavailable', 'The selected CLI authorization source cannot be read.');
  } finally { await handle?.close().catch(() => {}); }
}

/** Roots are trusted server configuration only. HTTP bodies must never reach this factory. */
export function createLocalSources({ home = homedir(), codexHome, openCodeDataHome, now = () => Date.now() } = {}) {
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
    return Promise.all(Object.keys(sources).map(async id => {
      try {
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
  }
  async function readLocalSource(source, provider) {
    if (!providerID(provider)) throw error('unsupported-provider', 'The selected source provider is not supported.');
    // Reread the same fixed source on every use: no cached token or refresh chain survives source logout.
    const matches = (await entries(source)).filter(item => item.provider === provider);
    if (!matches.length) throw error('source-unavailable', 'The selected provider is no longer present in the source CLI.');
    if (matches.length > 1) throw error('ambiguous-source', 'Multiple source entries map to this provider. Select one in the source CLI before connecting.');
    return { provider, grant: matches[0].grant(), owner: 'external-managed', source: { id: source, provider }, label: labels[source] };
  }
  return { discoverLocalSources, readLocalSource };
}

const defaults = createLocalSources({
  codexHome: process.env.CODEX_HOME && isAbsolute(process.env.CODEX_HOME) ? process.env.CODEX_HOME : undefined,
  openCodeDataHome: process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : undefined,
});
export const discoverLocalSources = () => defaults.discoverLocalSources();
export const readLocalSource = (source, provider) => defaults.readLocalSource(source, provider);
