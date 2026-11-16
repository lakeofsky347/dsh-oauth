import { mkdir, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

export async function withStoreLock(path, callback) {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try { await mkdir(lock); await writeFile(join(lock, 'owner'), String(process.pid), { mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 30000) {
        const pid = Number(await readFile(join(lock, 'owner'), 'utf8').catch(() => ''));
        let alive = false;
        if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, 0); alive = true; } catch (cause) { alive = cause.code !== 'ESRCH'; }
        if (!alive) { await rm(lock, { recursive: true, force: true }); continue; }
      }
      if (Date.now() > deadline) throw new Error('Profile store is busy; try again.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await callback(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

/** Atomic, profile-scoped JSON. Only non-secret derived state belongs here. */
export function createProfileStore(directory, filename) {
  if (!directory) throw new Error('A profile directory is required.');
  const path = join(directory, filename);
  const read = async () => {
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (data?.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error('Invalid profile store; original file retained.');
      return data.entries;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  };
  const mutate = callback => withStoreLock(path, async () => {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const entries = await read(); if (await callback(entries) === false) return;
      await writeFile(temp, JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600 });
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
  });
  return {
    read: async id => (await read())[id],
    write: (id, value, condition = () => true) => mutate(entries => { if (!condition()) return false; entries[id] = value; }),
    delete: id => mutate(entries => { delete entries[id]; }),
  };
}
