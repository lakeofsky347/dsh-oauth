#!/usr/bin/env node
/**
 * Install and verify a trusted release tarball without registry access or live
 * credentials. Peers come from the selected, already-installed DSH runtime.
 *
 * node scripts/verify-package.mjs --tarball /path/to/package.tgz --runtime /path/to/runtime
 * Optional: --out /path/to/report.json
 */
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageName = '@lks347/dsh-oauth';
const argument = name => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return resolve(value);
};
const tarball = argument('--tarball');
const runtime = argument('--runtime');
const output = argument('--out');
assert.ok(tarball && runtime, '--tarball and --runtime are required');
const modules = basename(runtime) === 'node_modules' ? runtime : join(runtime, 'node_modules');
const runtimeRequire = createRequire(join(modules, '.dsh-package-verifier.cjs'));
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const temporary = await mkdtemp(join(tmpdir(), 'dsh-oauth-package-'));
const runOptions = { maxBuffer: 8 * 1024 * 1024, timeout: 120000 };

async function overlayRuntime() {
  const destination = join(temporary, 'node_modules');
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const add = async (name, source) => {
      const target = join(destination, name);
      if (await lstat(target).catch(() => undefined)) return;
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(source), target, 'dir');
    };
    if (entry.name.startsWith('@')) {
      for (const name of await readdir(join(modules, entry.name))) await add(`${entry.name}/${name}`, join(modules, entry.name, name));
    } else await add(entry.name, join(modules, entry.name));
  }
}

function checkPath(path) {
  assert.ok(path.startsWith('package/'), 'Archive entry must stay under package/');
  assert.ok(!path.includes('\\') && !path.includes('\0') && !path.split('/').includes('..'), 'Archive has an unsafe entry');
  const inside = path.slice('package/'.length);
  const segments = inside.split('/');
  assert.ok(!segments.some(segment => ['node_modules', 'artifacts', '.git', '.npmrc', '.credentials.yaml', '.credentials.yml', 'auth.json', 'credentials.json'].includes(segment)), `Forbidden packaged path: ${inside}`);
  assert.ok(!segments.some(segment => segment === '.env' || segment.startsWith('.env.')), `Environment file must not be packaged: ${inside}`);
  assert.ok(!inside.endsWith('.tgz'), `Nested package archive must not be shipped: ${inside}`);
  return inside;
}

// High-confidence accidental secrets only. Matches report filenames, never the
// matched value. Fixture words such as "offline-key" are intentionally allowed.
const secretPatterns = [
  ['npm-token', /npm_[A-Za-z0-9]{30,}/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['openrouter-key', /sk-or-v1-[A-Za-z0-9]{25,}/],
  ['openai-project-key', /sk-proj-[A-Za-z0-9_-]{40,}/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['jwt-literal', /eyJ[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{30,}/],
];

async function executeInstalledCheck(path, extra = []) {
  const { stdout } = await execFile(process.execPath, [path, '--runtime', runtime, ...extra], {
    ...runOptions,
    cwd: temporary,
    env: { ...process.env, DSH_HOME: join(temporary, 'test-home'), CODEX_HOME: join(temporary, 'no-codex'), XDG_DATA_HOME: join(temporary, 'no-cli-data') },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true, `${basename(path)} did not pass`);
  return report;
}

try {
  const bytes = await readFile(tarball);
  assert.ok(bytes.length > 0 && bytes.length < 32 * 1024 * 1024, 'Tarball is empty or unexpectedly large');
  const { stdout: listed } = await execFile('tar', ['-tzf', tarball], runOptions);
  const { stdout: verbose } = await execFile('tar', ['-tvzf', tarball], runOptions);
  for (const line of verbose.trim().split('\n')) assert.ok(line.startsWith('-') || line.startsWith('d'), 'Archive may contain only regular files and directories');
  const filePaths = listed.trim().split('\n').filter(Boolean).map(checkPath).filter(path => path && !path.endsWith('/'));
  assert.equal(new Set(filePaths).size, filePaths.length, 'Duplicate archive entries are not allowed');
  const required = ['package.json', 'client.js', 'cordis.patch.yml', 'src/index.js', 'src/usage/index.js', 'README.md', 'README.en.md', 'docs/CONNECTIONS.md', 'docs/VALIDATION.md', 'scripts/verify-host.mjs', 'scripts/verify-persistence.mjs'];
  for (const path of required) assert.ok(filePaths.includes(path), `Missing required release file: ${path}`);

  // An isolated npm installation proves the scoped directory and exports are
  // actually installed. --offline and --legacy-peer-deps prevent registry/peer
  // downloads; --ignore-scripts prevents package lifecycle execution.
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'dsh-oauth-package-check', version: '0.0.0', private: true, type: 'module' }));
  const userConfig = join(temporary, 'empty.npmrc');
  await writeFile(userConfig, '', { mode: 0o600 });
  await execFile('npm', ['install', '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--package-lock=false', '--save=false', tarball], {
    ...runOptions, cwd: temporary,
    env: { ...process.env, npm_config_userconfig: userConfig, npm_config_cache: join(temporary, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org/' },
  });
  const installedPath = join(temporary, 'node_modules', '@lks347', 'dsh-oauth');
  assert.equal((await lstat(installedPath)).isSymbolicLink(), false, 'The tarball must be extracted, not linked to the worktree');
  const installedRoot = await realpath(installedPath);
  const installed = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installed.name, packageName);
  assert.notEqual(installed.private, true, 'Release package is marked private');
  assert.equal(installed.publishConfig?.access, 'public');
  assert.match(installed.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  const fileHashes = {};
  for (const path of filePaths) {
    const target = join(installedRoot, path);
    assert.equal((await lstat(target)).isFile(), true, `Installed path is not a regular file: ${path}`);
    const content = await readFile(target);
    fileHashes[path] = digest(content);
    for (const [kind, pattern] of secretPatterns) assert.ok(!pattern.test(content.toString('utf8')), `Possible ${kind} in packaged file ${path}; value withheld`);
  }

  await overlayRuntime();
  const installedRequire = createRequire(join(temporary, 'package.json'));
  const main = installedRequire.resolve(packageName);
  const client = installedRequire.resolve(`${packageName}/client`);
  const manifest = installedRequire.resolve(`${packageName}/package.json`);
  for (const entry of [main, client, manifest]) assert.ok(relative(installedRoot, entry) !== '..' && !relative(installedRoot, entry).startsWith(`..${sep}`), 'Package exports escaped the installed package');
  assert.equal(manifest, join(installedRoot, 'package.json'));
  const module = await import(pathToFileURL(main).href);
  assert.equal(typeof module.apply, 'function');
  const patchPath = resolve(installedRoot, installed.dsh.bundle.patch);
  assert.ok(!relative(installedRoot, patchPath).startsWith('..'), 'Bundle patch escaped the installed package');
  const { parse } = runtimeRequire('yaml');
  const patches = parse(await readFile(patchPath, 'utf8'));
  const entries = patches.flatMap(patch => patch.insert ?? []);
  const entry = entries.find(item => item.id === 'dsh-oauth');
  assert.equal(entry?.name, packageName, 'Bundle patch must resolve the scoped package');
  assert.equal(installedRequire.resolve(entry.name), main);
  let descriptor;
  new Function('window', await readFile(client, 'utf8'))({ __ModuleLoader__: { load(value) { assert.equal(descriptor, undefined, 'Client registered more than one module'); descriptor = value; } } });
  assert.equal(descriptor?.id, packageName, 'Client module ID must equal the installed package name');
  assert.equal(typeof descriptor?.factory, 'function');
  for (const name of installed.dsh.client.inject) installedRequire.resolve(name);

  const [host, persistence] = await Promise.all([
    executeInstalledCheck(join(installedRoot, 'scripts', 'verify-host.mjs')),
    executeInstalledCheck(join(installedRoot, 'scripts', 'verify-persistence.mjs')),
  ]);
  for (const [path, hash] of Object.entries(host.sourceSha256 ?? {})) assert.equal(fileHashes[path], hash, `Host check did not use the tarball's bytes: ${path}`);
  const report = {
    ok: true,
    checkedAt: new Date().toISOString(),
    package: `${installed.name}@${installed.version}`,
    tarball: { filename: basename(tarball), bytes: bytes.length, sha256: digest(bytes), integrity: `sha512-${digest(bytes, 'sha512', 'base64')}` },
    installedWith: 'npm install --offline --ignore-scripts --legacy-peer-deps (isolated temporary root and cache)',
    files: filePaths.length,
    checks: ['archive paths and types', 'no credential files or high-confidence literal secrets', 'scoped npm installation', 'package exports resolve inside extracted package', 'bundle patch resolves scoped server entry', 'client loader ID matches package name', 'declared client injections resolve', 'installed host smoke', 'installed persistence smoke', 'host-tested bytes match tarball'],
    host: { versions: host.versions, checks: host.checks },
    persistence: { versions: persistence.versions, processes: persistence.checks?.length, checks: persistence.checks },
    sourceSha256: fileHashes,
    boundaries: { registry: 'No registry requests; installation is offline', providers: 'Mock HTTP; no real credential source or paid inference', isolation: 'Temporary installation/profile/cache removed after verification', secretScan: 'Path checks and high-confidence signatures, not proof that arbitrary text cannot contain a secret' },
  };
  if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
