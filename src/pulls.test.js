import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPullStore } from "./pulls.js";

async function temporaryProfiles(t) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-oauth-pulls-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, a: join(directory, "profiles", "a"), b: join(directory, "profiles", "b") };
}

const pull = (id) => ({ models: [{ id, name: id, role: "chat" }], media: [], expiresAt: Date.now() + 3600000 });

test('permanent imports retain model capabilities and route ownership after reopening', async t => {
  const { a: directory } = await temporaryProfiles(t);
  const model = { id: 'rich', name: 'Rich model', role: 'chat', input: ['text', 'image'], output: ['text'], tools: true, contextWindow: 128000, maxTokens: 8192, reasoningEfforts: { high: 'high' }, source: 'account', entitlement: 'account' };
  const saved = { models: [model], media: [], expiresAt: null, route: { edits: [] } };
  await createPullStore(directory).write('openrouter', saved);
  const fresh = createPullStore(directory);
  assert.deepEqual(await fresh.read('openrouter'), saved);
  assert.equal((await fresh.list())[0].expiresAt, null);
});

test('separate processes cannot lose another provider during concurrent persistence', async t => {
  const { a: directory } = await temporaryProfiles(t);
  const module = new URL('./pulls.js', import.meta.url).href;
  const script = `import {createPullStore} from ${JSON.stringify(module)}; const [dir,id]=process.argv.slice(1); await createPullStore(dir).write(id,{models:[{id,name:id,role:'chat'}],expiresAt:null});`;
  await Promise.all(Array.from({ length: 6 }, (_, i) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, directory, `provider-${i}`])));
  assert.equal((await createPullStore(directory).list()).length, 6);
});

test("two profiles retain independent pulls for the same provider", async (t) => {
  const paths = await temporaryProfiles(t);
  const a = createPullStore(paths.a);
  const b = createPullStore(paths.b);
  await Promise.all([a.write("xai", pull("model-a")), b.write("xai", pull("model-b"))]);
  assert.equal((await a.read("xai")).models[0].id, "model-a");
  assert.equal((await b.read("xai")).models[0].id, "model-b");
  assert.deepEqual((await a.list()).map((row) => row.models[0].id), ["model-a"]);
  assert.deepEqual((await b.list()).map((row) => row.models[0].id), ["model-b"]);
});

test("concurrent writes through separate stores for one profile retain every provider", async (t) => {
  const { a: directory } = await temporaryProfiles(t);
  const stores = [createPullStore(directory), createPullStore(directory)];
  const ids = Array.from({ length: 32 }, (_, index) => `provider-${index}`);
  await Promise.all(ids.map((id, index) => stores[index % stores.length].write(id, pull(`model-${index}`))));
  const rows = await stores[0].list();
  assert.equal(rows.length, ids.length);
  assert.deepEqual(new Set(rows.map((row) => row.id)), new Set(ids));
  for (let index = 0; index < ids.length; index += 1) {
    assert.equal((await stores[1].read(ids[index])).models[0].id, `model-${index}`);
  }
});

test("route ownership retains exact prior and written capabilities across persistence", async (t) => {
  const { a: directory } = await temporaryProfiles(t);
  const store = createPullStore(directory);
  const route = { edits: [
    {
      path: ["providers", "xai", "models"],
      before: [{ id: "before", maxTokens: 4096, reasoningEfforts: false }],
      written: [{ id: "new", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"], reasoningEfforts: { low: "low", high: "high" } }],
    },
    { path: ["providers", "xai", "displayName"], written: "Pulled provider" },
  ] };
  await store.write("xai", { ...pull("new"), route });
  const readBack = await createPullStore(directory).read("xai");
  assert.deepEqual(readBack.route, route);
  assert.equal(Object.hasOwn(readBack.route.edits[1], "before"), false);
  assert.deepEqual((await store.list())[0].route, route);
});

test("malformed JSON and malformed store documents reject reads and writes without replacing their bytes", async (t) => {
  const { directory } = await temporaryProfiles(t);
  const documents = ["{broken-json", JSON.stringify({ version: 1, pulls: null }), JSON.stringify({ version: 1, pulls: [] })];
  for (let index = 0; index < documents.length; index += 1) {
    const profile = join(directory, `corrupt-${index}`);
    await mkdir(profile, { recursive: true });
    const path = join(profile, "dsh-oauth-pulls.json");
    const bytes = documents[index];
    await writeFile(path, bytes);
    const store = createPullStore(profile);
    await assert.rejects(store.read("xai"), `read must reject corrupt store ${index}`);
    await assert.rejects(store.write("xai", pull("replacement")), `write must reject corrupt store ${index}`);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
});

test("a rejected write does not prevent later writes after the damaged store is explicitly repaired", async (t) => {
  const { a: directory } = await temporaryProfiles(t);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "dsh-oauth-pulls.json");
  await writeFile(path, "invalid-json");
  const store = createPullStore(directory);
  await assert.rejects(store.write("xai", pull("failed")));
  await writeFile(path, JSON.stringify({ version: 1, pulls: {} }));
  await store.write("xai", pull("repaired"));
  assert.equal((await store.read("xai")).models[0].id, "repaired");
});

test("legacy global records are neither imported nor modified by a scoped profile store", async (t) => {
  const { directory, a: profile } = await temporaryProfiles(t);
  const legacyPath = join(directory, "dsh-oauth-pulls.json");
  const legacyBytes = JSON.stringify({ version: 1, pulls: { xai: { ...pull("legacy"), route: { edits: [{ path: ["providers", "xai"], written: { models: [{ id: "legacy" }] } }] } } } }, null, 2);
  await writeFile(legacyPath, legacyBytes);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  try {
    const store = createPullStore(profile);
    assert.equal(await store.read("xai"), undefined);
    assert.deepEqual(await store.list({ includeExpired: true }), []);
    await store.write("xai", pull("profile-only"));
    assert.equal((await store.read("xai")).models[0].id, "profile-only");
    await store.delete("xai");
    assert.equal(await readFile(legacyPath, "utf8"), legacyBytes);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  }
});

test("deleting one profile's provider leaves the other profile and its ownership unchanged", async (t) => {
  const paths = await temporaryProfiles(t);
  const a = createPullStore(paths.a);
  const b = createPullStore(paths.b);
  const ownership = { edits: [{ path: ["providers", "xai", "models"], before: [{ id: "prior-b" }], written: [{ id: "model-b" }] }] };
  await a.write("xai", pull("model-a"));
  await b.write("xai", { ...pull("model-b"), route: ownership });
  const bPath = join(paths.b, "dsh-oauth-pulls.json");
  const before = await readFile(bPath, "utf8");
  await a.delete("xai");
  assert.equal(await a.read("xai"), undefined);
  assert.equal((await b.read("xai")).models[0].id, "model-b");
  assert.deepEqual((await b.read("xai")).route, ownership);
  assert.equal(await readFile(bPath, "utf8"), before);
});

test("expired pulls remain available to maintenance while normal listing excludes them", async (t) => {
  const { a: directory } = await temporaryProfiles(t);
  const store = createPullStore(directory);
  await store.write("expired", { ...pull("old"), expiresAt: 1 });
  await store.write("live", pull("current"));
  assert.deepEqual((await store.list()).map((row) => row.id), ["live"]);
  assert.deepEqual(new Set((await store.list({ includeExpired: true })).map((row) => row.id)), new Set(["expired", "live"]));
  assert.equal((await store.read("expired")).models[0].id, "old");
});

test("creating a scoped store requires an explicit profile directory", () => {
  assert.throws(() => createPullStore(undefined), /profileContext.dir/);
  assert.throws(() => createPullStore(""), /profileContext.dir/);
});
