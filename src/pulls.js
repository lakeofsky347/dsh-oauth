import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function storePath() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "dsh-oauth-pulls.json");
}

async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.pulls && typeof parsed.pulls === "object") return parsed.pulls;
  } catch {
    /* absent file is an empty book */
  }
  return {};
}

async function writeAll(pulls) {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, pulls }, null, 2));
  await rename(temporary, path);
}

/** @param {string} id */
export async function readPull(id) {
  const pull = (await readAll())[id];
  if (!pull || typeof pull !== "object") return undefined;
  if (!Array.isArray(pull.models) || typeof pull.expiresAt !== "number") return undefined;
  const mapModels = (list) => (Array.isArray(list) ? list : []).filter((model) => model && typeof model.id === "string").map((model) => ({
    id: model.id,
    name: typeof model.name === "string" ? model.name : model.id,
    role: model.role === "image" || model.role === "video" ? model.role : "chat",
  }));
  return {
    models: mapModels(pull.models),
    media: mapModels(pull.media),
    expiresAt: pull.expiresAt,
  };
}

/**
 * @param {string} id
 * @param {{ models: {id: string, name: string}[], expiresAt: number }} pull
 */
export async function writePull(id, pull) {
  const pulls = await readAll();
  pulls[id] = pull;
  await writeAll(pulls);
}

export async function listPulls() {
  const pulls = await readAll();
  const live = [];
  for (const [id, pull] of Object.entries(pulls)) {
    if (!pull || typeof pull.expiresAt !== "number" || pull.expiresAt <= Date.now()) continue;
    live.push({
      id,
      models: Array.isArray(pull.models) ? pull.models : [],
      media: Array.isArray(pull.media) ? pull.media : [],
      expiresAt: pull.expiresAt,
    });
  }
  return live;
}

/** @param {string} id */
export async function deletePull(id) {
  const pulls = await readAll();
  delete pulls[id];
  await writeAll(pulls);
}
