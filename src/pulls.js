import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withStoreLock } from './profile-store.js';

function storePath(directory) {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(directory ?? home, "dsh-oauth-pulls.json");
}

async function readAll(directory) {
  try {
    const parsed = JSON.parse(await readFile(storePath(directory), "utf8"));
    if (parsed?.version === 1 && parsed.pulls && typeof parsed.pulls === "object" && !Array.isArray(parsed.pulls)) return parsed.pulls;
    throw new Error("OAuth 拉取记录格式无效，已保留原文件");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {};
}

async function writeAll(pulls, directory) {
  const path = storePath(directory);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, pulls }, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

/** @param {string} id */
export async function readPull(id, directory) {
  const pull = (await readAll(directory))[id];
  if (!pull || typeof pull !== "object") return undefined;
  if (!Array.isArray(pull.models) || pull.expiresAt !== null && !Number.isFinite(pull.expiresAt)) return undefined;
  const mapModels = (list) => (Array.isArray(list) ? list : []).filter((model) => model && typeof model.id === "string").map((model) => ({
    ...model,
    id: model.id,
    name: typeof model.name === "string" ? model.name : model.id,
    role: model.role === "image" || model.role === "video" ? model.role : "chat",
  }));
  return {
    ...pull,
    models: mapModels(pull.models),
    media: mapModels(pull.media),
    expiresAt: pull.expiresAt,
  };
}

/**
 * @param {string} id
 * @param {{ models: {id: string, name: string}[], expiresAt: number }} pull
 */
export async function writePull(id, pull, directory) {
  return updateAll(async (pulls) => { pulls[id] = pull; }, directory);
}

export async function listPulls({ includeExpired = false, directory } = {}) {
  const pulls = await readAll(directory);
  const live = [];
  for (const [id, pull] of Object.entries(pulls)) {
    if (!pull || pull.expiresAt !== null && (!Number.isFinite(pull.expiresAt) || !includeExpired && pull.expiresAt <= Date.now())) continue;
    live.push({
      ...pull,
      id,
      models: Array.isArray(pull.models) ? pull.models : [],
      media: Array.isArray(pull.media) ? pull.media : [],
      expiresAt: pull.expiresAt,
    });
  }
  return live;
}

/** @param {string} id */
export async function deletePull(id, directory) {
  return updateAll(async (pulls) => { delete pulls[id]; }, directory);
}

const writes = new Map();
function updateAll(mutate, directory) {
  const key = storePath(directory);
  const next = (writes.get(key) ?? Promise.resolve()).then(() => withStoreLock(key, async () => {
    const pulls = await readAll(directory);
    await mutate(pulls);
    await writeAll(pulls, directory);
  }));
  writes.set(key, next.catch(() => {}));
  return next;
}

/** Scope new records to the launcher-owned profile; the old global file is left untouched. */
export function createPullStore(directory) {
  if (typeof directory !== "string" || directory.length === 0) throw new Error("OAuth 拉取记录需要当前 profileContext.dir");
  return {
    read: (id) => readPull(id, directory),
    write: (id, pull) => writePull(id, pull, directory),
    delete: (id) => deletePull(id, directory),
    list: (options = {}) => listPulls({ ...options, directory }),
  };
}
