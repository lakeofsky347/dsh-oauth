import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { createConnections, nativeKey, connectionKey, connectionRef } from './connections.js';
import { readLocalSource } from './local-imports.js';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const changed = () => Object.assign(new Error('The connection changed while its credential was being resolved. Retry with the selected connection.'), { code: 'connection-changed' });

export function createConnectionRuntime(credentials, nativeResolve, { localRead = readLocalSource, modelsFactory = builtinModels } = {}) {
  const connections = createConnections(credentials);
  const registry = modelsFactory({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const resolutions = new Map();
  // No-op atomic reads see canonical storage, not a possibly stale watcher cache.
  const readRecord = key => credentials.modifyRecord(key, () => undefined);
  const connectionFor = async id => {
    const record = await readRecord(connectionKey(id));
    return record?.kind === 'grant' ? record.payload : undefined;
  };
  const sameConnection = (a, b) => a?.revision === b?.revision && a?.mode === b?.mode && a?.localSource === b?.localSource;
  const check = async (id, selected, sequence) => { if (!sameConnection(selected, await connectionFor(id)) || sequence !== undefined && resolutions.get(id) !== sequence) throw changed(); };
  const ownerFor = connection => ({ owner: 'external-managed', revision: connection.revision, source: connection.localSource });

  async function invalidateMirror(id, selected, expected) {
    // modifyRecord cannot atomically delete. An owner-tagged tombstone blocks
    // host use without deleting a newer native login in a read/delete gap.
    await credentials.modifyRecord(nativeKey(id), current => {
      const owner = current?.payload?.externalManaged;
      if (owner?.owner !== 'external-managed' || owner.revision !== selected.revision || !equal(current.payload, expected)) return undefined;
      return { kind: 'grant', payload: { type: 'oauth', access: '', expires: 0, externalManaged: owner, revoked: true } };
    });
  }
  async function clearLocalFailure(id, selected, expected, sequence) {
    if (resolutions.get(id) !== sequence) return;
    await invalidateMirror(id, selected, expected);
    if (sameConnection(selected, await connectionFor(id)) && resolutions.get(id) === sequence) await credentials.unset?.(connectionRef(id));
  }
  async function repairReference(id) {
    const latest = await connectionFor(id);
    if (latest?.mode === 'key') await credentials.set(connectionRef(id), latest.access);
    else await credentials.unset?.(connectionRef(id));
  }
  async function setReference(id, selected, access, sequence) {
    await check(id, selected, sequence);
    await credentials.set(connectionRef(id), access);
    try { await check(id, selected, sequence); }
    catch (error) { await repairReference(id); throw error; }
  }

  async function resolveSnapshot(id, options) {
    const connection = await connectionFor(id);
    const sequence = (resolutions.get(id) ?? 0) + 1;
    if (connection?.mode === 'key' || connection?.mode === 'local') resolutions.set(id, sequence);
    if (connection?.mode === 'key') {
      if (options?.rejectedGrant) throw new Error('The saved API key was rejected. Update the connection credential.');
      await setReference(id, connection, connection.access, sequence);
      const rawGrant = { type: 'api_key', access: connection.access };
      return { connection, rawGrant, grant: { ...rawGrant, ...connection.metadata } };
    }
    if (connection?.mode !== 'local') {
      if (id === 'anthropic') throw new Error('Connect a Claude Console API key in this plugin. Claude Code subscription sign-in is managed by Claude Code.');
      const grant = await nativeResolve(id, options);
      const rawGrant = typeof nativeResolve.rawGrant === 'function' ? await nativeResolve.rawGrant(grant) : (await readRecord(nativeKey(id)))?.payload;
      await check(id, connection);
      return { connection, grant, rawGrant };
    }

    const before = await readRecord(nativeKey(id));
    let imported;
    try { imported = await localRead(connection.localSource, id); }
    catch (error) { await clearLocalFailure(id, connection, before?.payload, sequence); throw error; }
    // Only normalized fields can enter the host mirror. Never transfer the
    // external CLI's rotating refresh token into the host's OAuth manager.
    const source = imported?.grant;
    if (!source || !['oauth', 'api_key'].includes(source.type) || typeof source.access !== 'string' || !source.access) {
      await clearLocalFailure(id, connection, before?.payload, sequence);
      throw Object.assign(new Error('The source CLI returned no usable credential.'), { code: 'source-unavailable' });
    }
    const rawGrant = { type: source.type, access: source.access };
    if (id === 'anthropic' && rawGrant.type === 'oauth') throw new Error('Connect a Claude Console API key in this plugin.');
    for (const key of ['expires', 'accountId', 'scope']) if (source[key] !== undefined) rawGrant[key] = source[key];
    await check(id, connection, sequence);
    if (rawGrant.type === 'api_key') {
      await setReference(id, connection, rawGrant.access, sequence);
      return { connection, rawGrant, grant: { ...rawGrant, ...connection.metadata } };
    }

    const payload = { ...rawGrant, externalManaged: ownerFor(connection) };
    let conflict = false;
    await credentials.modifyRecord(nativeKey(id), current => {
      if (!equal(current, before) && !equal(current?.payload, payload)) { conflict = true; return undefined; }
      return equal(current?.payload, payload) ? undefined : { kind: 'grant', payload };
    });
    if (conflict) throw changed();
    try { await check(id, connection, sequence); }
    catch (error) { await invalidateMirror(id, connection, payload); throw error; }
    const oauth = registry.getProvider(id)?.auth?.oauth;
    const auth = typeof oauth?.toAuth === 'function' ? await oauth.toAuth(rawGrant) : { apiKey: rawGrant.access };
    await check(id, connection, sequence);
    const access = auth?.apiKey ?? (id === 'kimi-coding' && auth?.headers ? rawGrant.access : undefined);
    if (!access) throw new Error('The source CLI credential cannot authorize this provider.');
    return { connection, rawGrant, grant: { ...rawGrant, access, ...(auth.headers ? { requestHeaders: auth.headers } : {}), ...(auth.baseUrl ? { apiBase: auth.baseUrl } : {}) } };
  }

  return {
    connections,
    resolve: async (id, options) => (await resolveSnapshot(id, options)).grant,
    async contextFor(id) {
      const { connection, grant, rawGrant } = await resolveSnapshot(id);
      if (!rawGrant?.access) throw new Error('Connection unavailable.');
      const metadata = { ...connection?.metadata };
      if (id === 'kimi-coding' && metadata.region === undefined && rawGrant.type === 'oauth') {
        if (['cn', 'global'].includes(rawGrant.region)) metadata.region = rawGrant.region;
        else {
          let host;
          try { const url = new URL(grant.apiBase); if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')) host = url.hostname; } catch {}
          metadata.region = host === 'api.kimi.ai' ? 'global' : 'cn';
        }
      }
      return { ...metadata, access: grant.access, rawGrant, connection, billingAccess: connection?.billingAccess };
    },
    async customRoute(id) {
      const connection = await connectionFor(id);
      if (connection?.mode === 'key') return true;
      if (connection?.mode !== 'local') return false;
      const imported = await localRead(connection.localSource, id);
      await check(id, connection);
      return imported.grant.type === 'api_key';
    },
  };
}
