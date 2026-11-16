import { createHash, randomUUID } from 'node:crypto';
import { credentialKey } from '@deepseek-ai/dsh-credentials';

export const connectionKey = id => credentialKey('dsh-oauth-connections', id);
export const nativeKey = id => credentialKey(id === 'qwen' ? 'dsh-oauth' : 'llm-pi-ai', id);
export const connectionRef = id => `DSH_OAUTH_${id.toUpperCase().replaceAll('-', '_')}_KEY`;
const metadataKeys = ['label', 'region', 'organizationId', 'projectId', 'workspaceId', 'baseURL'];
export function connectionMetadata(value = {}) {
  const out = {};
  for (const key of metadataKeys) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 200 || /[\x00-\x1f\x7f]/.test(value[key])) throw new Error(`Invalid connection field: ${key}`);
    if (key === 'region' && !['global', 'cn'].includes(value[key])) throw new Error('Invalid region.');
    if (key === 'baseURL') {
      const url = new URL(value[key]);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('A credential-free HTTPS base URL is required.');
      out[key] = url.toString().replace(/\/+$/, '');
    } else out[key] = value[key].trim();
  }
  return out;
}
export function validSecret(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32768 || /[\r\n]/.test(value)) throw new Error('A valid credential is required.');
  return value.trim();
}
export function accountFingerprint(connection, raw) {
  // Cache entries are bound to credentials and scope. This digest is never a token preview.
  return createHash('sha256').update(JSON.stringify([connection?.revision, raw?.accountId, raw?.account_id, raw?.access, connection?.metadata,
    raw?.region, raw?.organizationId, raw?.workspaceId, raw?.projectId, raw?.metadata, raw?.apiBase, raw?.resourceUrl])).digest('hex');
}
export function createConnections(credentials) {
  const read = async id => {
    const record = await credentials.modifyRecord(connectionKey(id), () => undefined);
    return record?.kind === 'grant' ? record.payload : undefined;
  };
  const save = async (id, payload) => credentials.modifyRecord(connectionKey(id), () => ({ kind: 'grant', payload }));
  return {
    read,
    raw: async id => (await credentials.readRecord(nativeKey(id)))?.payload,
    async connect(id, body) {
      const access = validSecret(body.access);
      const next = { mode: 'key', access, metadata: connectionMetadata(body), revision: randomUUID(), ...(body.billingAccess ? { billingAccess: validSecret(body.billingAccess) } : {}) };
      const before = await read(id);
      await save(id, next);
      try { await credentials.set(connectionRef(id), access); }
      catch (error) { if (before) await save(id, before); else await credentials.deleteRecord(connectionKey(id)); throw error; }
      return next;
    },
    async configure(id, body) {
      let saved;
      await credentials.modifyRecord(connectionKey(id), current => {
        const before = current?.kind === 'grant' ? current.payload : { mode: 'oauth' };
        saved = { ...before, metadata: { ...before.metadata, ...connectionMetadata(body) }, revision: randomUUID() };
        if (id === 'zai' && !!saved.metadata.organizationId !== !!saved.metadata.projectId) throw new Error('Z.AI organization and project IDs must be configured together.');
        if (body.billingAccess === '') delete saved.billingAccess;
        else if (body.billingAccess !== undefined) saved.billingAccess = validSecret(body.billingAccess);
        return { kind: 'grant', payload: saved };
      });
      return saved;
    },
    async saveLocal(id, source, sourceLabel) {
      const next = { mode: 'local', localSource: source, sourceLabel, metadata: {}, revision: randomUUID() };
      await save(id, next); return next;
    },
    async disconnect(id) {
      await credentials.deleteRecord(connectionKey(id));
      if (typeof credentials.unset === 'function') await credentials.unset(connectionRef(id));
    },
  };
}
