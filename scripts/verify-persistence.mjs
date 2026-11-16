#!/usr/bin/env node
/**
 * Offline persistence smoke using real Cordis, credentials-local and pi-ai.
 * No login, real profile, credential import or live request is performed.
 *
 * node scripts/verify-persistence.mjs --runtime /path/to/published-runtime
 * If that runtime omits credentials-local, prepare an independent dependency
 * directory once (VERSION must match its dsh-credentials version):
 *   npm install --prefix /tmp/dsh-persistence-deps --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh-credentials-local@VERSION
 * Then append:
 *   --credentials-local /tmp/dsh-persistence-deps/node_modules/@deepseek-ai/dsh-credentials-local
 * The verification itself is offline. The provider is copied into a sandbox;
 * selected runtime packages take precedence over supplementary dependencies.
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error(`${name} requires a path or value`);
  return process.argv[index + 1];
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MOCK_MODELS = [{ id: "mock-persisted-model", name: "Mock persisted model", role: "chat" }];
const ORIGINAL_MODELS = [{ id: "mock-original-model", name: "Mock original model" }];
const MOCK = { initialAccess: "mock-persistence-access-initial", initialRefresh: "mock-persistence-refresh-initial", firstAccess: "mock-persistence-access-refreshed", rotatedAccess: "mock-persistence-access-rotated", rotatedRefresh: "mock-persistence-refresh-rotated" };
const RESULT_PREFIX = "DSH_PERSISTENCE_RESULT=";

if (argument("--worker")) {
  await worker(argument("--worker"), resolve(argument("--sandbox")));
} else {
  await orchestrate();
}

async function overlayPackages(source, destination, added) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const target = join(destination, entry.name);
      await mkdir(target, { recursive: true });
      for (const name of await readdir(join(source, entry.name))) {
        const key = `${entry.name}/${name}`;
        if (added.has(key)) continue;
        await symlink(await realpath(join(source, entry.name, name)), join(target, name), "dir");
        added.add(key);
      }
    } else if (!added.has(entry.name)) {
      await symlink(await realpath(join(source, entry.name)), join(destination, entry.name), "dir");
      added.add(entry.name);
    }
  }
}

async function orchestrate() {
  const runtime = resolve(argument("--runtime") ?? root);
  const modules = runtime.endsWith("node_modules") ? runtime : join(runtime, "node_modules");
  const selected = createRequire(join(modules, ".persistence-resolver.cjs"));
  let providerRoot = argument("--credentials-local");
  if (providerRoot) providerRoot = resolve(providerRoot);
  else {
    try { providerRoot = dirname(selected.resolve("@deepseek-ai/dsh-credentials-local/package.json")); }
    catch { throw new Error("Selected runtime omits @deepseek-ai/dsh-credentials-local. Install the matching published version in an independent /tmp directory and pass --credentials-local; see this script's header."); }
  }
  const credentialsVersion = JSON.parse(await readFile(join(modules, "@deepseek-ai/dsh-credentials/package.json"), "utf8")).version;
  const providerPackage = JSON.parse(await readFile(join(providerRoot, "package.json"), "utf8"));
  assert.equal(providerPackage.name, "@deepseek-ai/dsh-credentials-local");
  assert.equal(providerPackage.version, credentialsVersion, "credentials-local must match the selected runtime's credentials package");
  const sandbox = await mkdtemp(join(tmpdir(), "dsh-oauth-persistence-"));
  const manifest = { marker: randomUUID(), createdAt: Date.now(), runtime, credentialsVersion, thirtyDayExpiry: Date.now() + 30 * 24 * 60 * 60 * 1000 };
  try {
    await mkdir(join(sandbox, "modules"), { recursive: true });
    const added = new Set();
    await overlayPackages(modules, join(sandbox, "modules"), added);
    // npm-installed supplemental dependencies supply home-paths/chokidar if the
    // host-smoke runtime omitted them. They never replace a selected peer.
    const supplement = join(providerRoot, "..", "..");
    if (dirname(supplement).endsWith("node_modules") || supplement.endsWith("node_modules")) {
      await overlayPackages(supplement, join(sandbox, "modules"), added);
    }
    await mkdir(join(sandbox, "provider"), { recursive: true });
    for (const entry of await readdir(providerRoot)) {
      if (entry === "node_modules") continue;
      await cp(join(providerRoot, entry), join(sandbox, "provider", entry), { recursive: true });
    }
    await symlink(join(sandbox, "modules"), join(sandbox, "provider", "node_modules"), "dir");
    await mkdir(join(sandbox, "plugin"), { recursive: true });
    for (const path of ["src", "package.json"]) await cp(join(root, path), join(sandbox, "plugin", path), { recursive: true });
    await symlink(join(sandbox, "modules"), join(sandbox, "plugin", "node_modules"), "dir");
    await mkdir(join(sandbox, "home", "profiles", "offline"), { recursive: true });
    await writeFile(join(sandbox, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const checks = [];
    for (const stage of ["seed", "refresh-without-rotation", "rotate", "network-failure", "expire-pull-through-host", "final-restart"]) {
      const { stdout, stderr } = await execFile(process.execPath, [script, "--worker", stage, "--sandbox", sandbox], {
        cwd: sandbox, env: { ...process.env, DSH_HOME: join(sandbox, "home"), DSH_OAUTH_PERSISTENCE_MARKER: manifest.marker },
        encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
      });
      const line = stdout.split("\n").find((value) => value.startsWith(RESULT_PREFIX));
      assert.ok(line, `${stage} did not return its structured result: ${stderr}`);
      checks.push(JSON.parse(line.slice(RESULT_PREFIX.length)));
    }
    assert.equal(new Set(checks.map((check) => check.pid)).size, checks.length, "each phase must run in a separate Node process");
    const versions = { credentialsLocal: providerPackage.version };
    for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-credentials", "@deepseek-ai/dsh-authorization", "@earendil-works/pi-ai"]) {
      versions[name] = JSON.parse(await readFile(join(modules, name, "package.json"), "utf8")).version;
    }
    const sourceSha256 = {};
    for (const path of ["src/grants.js", "src/pulls.js", "src/index.js", "src/routes.js", "src/request-errors.js", "src/chat-recovery.js", "src/xai-browser.js", "src/xai-login.js"]) sourceSha256[path] = digest(await readFile(join(sandbox, "plugin", path)));
    let selectedRuntimeProviderSha256 = null;
    try { selectedRuntimeProviderSha256 = digest(await readFile(selected.resolve("@deepseek-ai/dsh-credentials-local"))); } catch { /* The runtime may omit this optional provider. */ }
    const providerSha256 = digest(await readFile(join(sandbox, "provider", "lib", "index.js")));
    console.log(JSON.stringify({
      verificationScriptSha256: digest(await readFile(script)),
      ok: true, checkedAt: new Date().toISOString(), runtime, versions, sourceSha256,
      credentialsProvider: { source: argument("--credentials-local") ? "External package directory supplied by --credentials-local; this run used a separately npm-installed published provider" : "Package resolved from selected runtime", packageRoot: providerRoot, sha256: providerSha256, versionMatchesRuntimeCredentials: true, selectedRuntimeProviderSha256, selectedRuntimeProviderHashMatches: selectedRuntimeProviderSha256 === null ? null : selectedRuntimeProviderSha256 === providerSha256, actualDesktopAppProviderExtracted: false },
      checks, network: "All fetch calls are mocked and allow only the xAI refresh endpoint; no authentication or paid requests",
      storage: "Real published file-backed credentials-local provider, temporary DSH_HOME, six separate Node processes; sandbox deleted after verification",
      settingsBoundary: "The route-expiry phase uses the real host/pull/route components with in-memory settings; credential and pull files are real",
      evidenceBoundary: "Process restarts, forced expiry and rejection-before-expiry recovery are tested. Early rejection is simulated by passing the observed rejectedGrant, not a reproduced live upstream failure. This does not prove 30 elapsed days or a real account's refresh-token lifetime.",
      reproduce: { command: `node scripts/verify-persistence.mjs --runtime ${runtime} --credentials-local ${providerRoot}`, providerInstall: `npm install --prefix /tmp/dsh-persistence-deps --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh-credentials-local@${credentialsVersion}` },
    }, null, 2));
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}

async function worker(stage, sandbox) {
  const manifest = JSON.parse(await readFile(join(sandbox, "manifest.json"), "utf8"));
  assert.equal(manifest.marker, process.env.DSH_OAUTH_PERSISTENCE_MARKER, "workers only use this invocation's isolated sandbox");
  assert.equal(process.env.DSH_HOME, join(sandbox, "home"));
  const profile = join(sandbox, "home", "profiles", "offline");
  const credentialsFile = join(sandbox, "home", ".credentials.yaml");
  const requireRuntime = createRequire(join(sandbox, "plugin", "package.json"));
  const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href);
  const [{ Context, Service }, { credentialKey }, provider, { createGrantResolver }, { createPullStore }, { createConnections, connectionRef }, { createUsageService }] = await Promise.all([
    load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-credentials"), import(pathToFileURL(join(sandbox, "provider", "lib", "index.js")).href),
    import(pathToFileURL(join(sandbox, "plugin", "src", "grants.js")).href), import(pathToFileURL(join(sandbox, "plugin", "src", "pulls.js")).href),
    import(pathToFileURL(join(sandbox, 'plugin', 'src', 'connections.js')).href), import(pathToFileURL(join(sandbox, 'plugin', 'src', 'usage', 'index.js')).href),
  ]);
  const ctx = new Context();
  ctx.provide("profileContext", { name: "offline", dir: profile, home: process.env.DSH_HOME, patchPath: join(profile, "cordis.patch.yml") });
  let calls = 0;
  globalThis.fetch = async () => { throw new Error("Unexpected network request refused by persistence smoke"); };
  try {
    await ctx.plugin(provider.default, { path: credentialsFile, watch: false });
    const credentials = ctx.credentials;
    const key = credentialKey("llm-pi-ai", "xai");
    const pulls = createPullStore(profile);
    const connections = createConnections(credentials);
    const resolveGrant = createGrantResolver(credentials);
    const result = { stage, pid: process.pid, checks: [] };
    const mockRefresh = (refreshToken, response, failure = false) => {
      globalThis.fetch = async (url, options) => {
        calls += 1;
        assert.equal(String(url), "https://auth.x.ai/oauth2/token");
        assert.equal(options.method, "POST");
        const form = new URLSearchParams(options.body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("client_id"), "b1a00492-073a-47ea-816f-4c329264a828");
        assert.equal(form.get("refresh_token"), refreshToken);
        if (failure) throw new TypeError("mock temporary network failure");
        return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
      };
    };
    if (stage === "seed") {
      assert.equal(await credentials.readRecord(key), undefined);
      await credentials.modifyRecord(key, async () => ({ kind: "grant", payload: { type: "oauth", access: MOCK.initialAccess, refresh: MOCK.initialRefresh, expires: Date.now() - 1000 } }));
      await pulls.write("xai", { models: MOCK_MODELS, media: [], expiresAt: manifest.thirtyDayExpiry, route: { edits: [{ path: ["providers", "xai", "models"], written: MOCK_MODELS, before: ORIGINAL_MODELS }] } });
      assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
      assert.equal((await pulls.read("xai")).expiresAt, manifest.thirtyDayExpiry);
      result.checks.push("mock OAuth grant written through real file provider", "30-day pull written in isolated profile", "credential file mode is 0600");
      await connections.connect('openrouter', { access: 'offline-persistent-key', billingAccess: 'offline-persistent-billing', label: 'Offline saved account' });
      await pulls.write('openrouter', { models: [{ id: 'offline/rich', name: 'Offline', role: 'chat', input: ['text', 'image'], output: ['text'], tools: true, reasoningEfforts: { high: 'high' }, contextWindow: 128000, maxTokens: 8192, source: 'account', entitlement: 'account' }], media: [], expiresAt: null });
      const usage = createUsageService({ directory: profile, contextFor: async () => ({ access: 'offline-persistent-key', rawGrant: { access: 'offline-persistent-key' }, connection: await connections.read('openrouter') }), reader: async () => ({ windows: [{ id: 'budget', unit: 'money', used: 2, limit: 10, remaining: 8 }], balances: [] }) });
      assert.equal((await usage.get('openrouter')).status, 'fresh');
      result.checks.push('subscription call and billing credentials stored by real credential provider', 'permanent model capabilities and real-source quota snapshot persisted');
    } else if (stage === "refresh-without-rotation") {
      const stored = await credentials.readRecord(key);
      assert.equal(stored.payload.access, MOCK.initialAccess);
      assert.equal(stored.payload.refresh, MOCK.initialRefresh);
      assert.equal((await pulls.read("xai")).expiresAt, manifest.thirtyDayExpiry);
      mockRefresh(MOCK.initialRefresh, { access_token: MOCK.firstAccess, expires_in: 3600 });
      const renewed = await resolveGrant("xai");
      assert.equal(renewed.access, MOCK.firstAccess);
      assert.equal(renewed.refresh, MOCK.initialRefresh);
      assert.ok(renewed.expires > Date.now());
      assert.equal((await credentials.readRecord(key)).payload.refresh, MOCK.initialRefresh);
      assert.equal(calls, 1);
      result.checks.push("new process reads prior grant and 30-day pull", "real pi xAI refresh protocol used with fetch mock", "omitted refresh_token preserves prior refresh token");
    } else if (stage === "rotate") {
      const stored = await credentials.readRecord(key);
      assert.equal(stored.payload.access, MOCK.firstAccess);
      assert.equal(stored.payload.refresh, MOCK.initialRefresh);
      assert.ok(stored.payload.expires > Date.now() + 20 * 60 * 1000, "stored access is still locally valid before forced recovery");
      const observedGrant = await resolveGrant("xai");
      assert.equal(observedGrant.access, MOCK.firstAccess);
      assert.equal(calls, 0, "ordinary resolution must not refresh a future-expiry access token");
      mockRefresh(MOCK.initialRefresh, { access_token: MOCK.rotatedAccess, refresh_token: MOCK.rotatedRefresh, expires_in: 3600 });
      const renewed = await resolveGrant("xai", { rejectedGrant: observedGrant });
      assert.equal(renewed.access, MOCK.rotatedAccess);
      assert.equal(renewed.refresh, MOCK.rotatedRefresh);
      assert.equal(calls, 1, "observed upstream rejection forces refresh even before local expiry");
      const recoveredFromStaleSnapshot = await resolveGrant("xai", { rejectedGrant: observedGrant });
      assert.equal(recoveredFromStaleSnapshot.access, MOCK.rotatedAccess);
      assert.equal(recoveredFromStaleSnapshot.refresh, MOCK.rotatedRefresh);
      assert.equal(calls, 1, "a late rejection of the old snapshot reuses the already refreshed token");
      result.checks.push("new process reads previous refreshed access with future expiry", "ordinary resolution sends no refresh request before expiry", "observed rejectedGrant forces real pi refresh protocol before advertised expiry", "rotating refresh response is committed through real file provider", "a stale rejected snapshot reuses the newer saved token without a second refresh");
    } else if (stage === "network-failure") {
      const stored = await credentials.readRecord(key);
      assert.equal(stored.payload.access, MOCK.rotatedAccess);
      assert.equal(stored.payload.refresh, MOCK.rotatedRefresh);
      await credentials.modifyRecord(key, async (current) => ({ ...current, payload: { ...current.payload, expires: Date.now() - 1000 } }));
      const before = await credentials.readRecord(key);
      const bytesBefore = await readFile(credentialsFile);
      mockRefresh(MOCK.rotatedRefresh, undefined, true);
      await assert.rejects(resolveGrant("xai"));
      assert.deepEqual(await credentials.readRecord(key), before);
      assert.equal(digest(await readFile(credentialsFile)), digest(bytesBefore));
      assert.equal((await pulls.read("xai")).expiresAt, manifest.thirtyDayExpiry);
      assert.equal(calls, 1);
      result.checks.push("new process reads rotated refresh token", "temporary refresh network failure leaves record and credential file unchanged", "30-day pull remains unchanged");
    } else if (stage === "expire-pull-through-host") {
      const before = await credentials.readRecord(key);
      assert.equal(before.payload.refresh, MOCK.rotatedRefresh);
      assert.equal((await pulls.read("xai")).expiresAt, manifest.thirtyDayExpiry);
      const previous = await pulls.read("xai");
      await pulls.write("xai", { ...previous, expiresAt: Date.now() - 1000 });
      let settings = { providers: { xai: { models: MOCK_MODELS } } };
      let revision = 0;
      const routes = [];
      class MemorySettings extends Service {
        constructor(context) { super(context, "settings"); }
        describe() { return [{ ns: "llm-pi-ai", user: structuredClone(settings), value: structuredClone(settings), revision }]; }
        async mutate(namespace, operations, expectedRevision) {
          assert.equal(namespace, "llm-pi-ai"); assert.equal(expectedRevision, revision);
          for (const operation of operations) {
            let object = settings;
            for (const segment of operation.path.slice(0, -1)) object = object[segment] ??= {};
            if (operation.op === "unset") delete object[operation.path.at(-1)]; else object[operation.path.at(-1)] = structuredClone(operation.value);
          }
          revision += 1;
        }
      }
      class MemoryWebServer extends Service {
        constructor(context) { super(context, "webServer"); }
        register(route) { routes.push(route); return () => {}; }
      }
      await ctx.plugin(MemorySettings); await ctx.plugin(MemoryWebServer);
      const { default: AuthorizationService } = await load("@deepseek-ai/dsh-authorization");
      await ctx.plugin(AuthorizationService);
      ctx.authorization.registerFlow({ key, label: "Mock xAI", methods: [{ id: "oauth", label: "Mock OAuth" }], async run() { throw new Error("Smoke must not initiate authentication"); } });
      const host = await import(pathToFileURL(join(sandbox, "plugin", "src", "index.js")).href);
      await ctx.plugin(host);
      const route = routes.find((entry) => entry.path === "/oauth");
      assert.ok(route);
      // Startup maintenance runs asynchronously. Wait only for this temporary
      // pull's cleanup, then check the public provider endpoint as well.
      const deadline = Date.now() + 2000;
      while (await pulls.read("xai")) {
        assert.ok(Date.now() < deadline, "host did not clean expired pull");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      const req = Readable.from([]);
      Object.assign(req, { method: "GET", url: "/oauth/api/providers", headers: { host: "127.0.0.1:19387" } });
      const response = { status: 0, body: "", writeHead(code) { this.status = code; }, end(body) { this.body = String(body ?? ""); } };
      await route.handler(req, response);
      assert.equal(response.status, 200);
      const row = JSON.parse(response.body).providers.find((entry) => entry.id === "xai");
      assert.equal(row.loggedIn, true);
      assert.equal(row.pullExpiresAt, null);
      assert.deepEqual(settings.providers.xai.models, ORIGINAL_MODELS);
      assert.deepEqual(await credentials.readRecord(key), before);
      assert.equal(calls, 0);
      result.checks.push("real host restores only expired pull's owned route edits", "expired pull removed while OAuth grant stays byte-equivalent", "provider endpoint still reports configured grant after route expiry");
    } else if (stage === "final-restart") {
      const stored = await credentials.readRecord(key);
      assert.equal(stored.payload.access, MOCK.rotatedAccess);
      assert.equal(stored.payload.refresh, MOCK.rotatedRefresh);
      assert.equal(await pulls.read("xai"), undefined);
      result.checks.push("final independent process reads surviving rotated grant", "pull expiry cleanup persists across restart");
    } else throw new Error(`Unknown worker stage: ${stage}`);
    if (stage !== 'seed') {
      const connection = await connections.read('openrouter');
      assert.equal(connection.access, 'offline-persistent-key');
      assert.equal(connection.billingAccess, 'offline-persistent-billing');
      assert.equal((await credentials.resolve(connectionRef('openrouter'))).value, 'offline-persistent-key');
      const permanent = await pulls.read('openrouter');
      assert.equal(permanent.expiresAt, null); assert.equal(permanent.models[0].tools, true);
      assert.deepEqual(permanent.models[0].input, ['text', 'image']); assert.deepEqual(permanent.models[0].reasoningEfforts, { high: 'high' });
      assert.equal((await readFile(join(profile, 'dsh-oauth-pulls.json'), 'utf8')).includes('offline-persistent-key'), false);
      const quota = await readFile(join(profile, 'dsh-oauth-usage.json'), 'utf8');
      assert.equal(quota.includes('offline-persistent-key'), false); assert.equal(JSON.parse(quota).entries.openrouter.result.snapshot.windows[0].remaining, 8);
      result.checks.push('independent process retains permanent subscription models, capabilities, scoped credentials and quota observation without leaking secrets into JSON');
    }
    result.mockRefreshRequests = calls;
    console.log(RESULT_PREFIX + JSON.stringify(result));
  } finally { await ctx.fiber.dispose(); }
}
