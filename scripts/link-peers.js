/** Link development peers from an explicit DSH installation. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fromFlag = process.argv.indexOf("--from");
const source = resolve(fromFlag >= 0 ? process.argv[fromFlag + 1] : join(process.env.DSH_HOME || join(homedir(), ".dsh"), "profiles"));
const req = createRequire(join(source, "package.json"));
const names = ["@deepseek-ai/dsh-authorization", "@deepseek-ai/dsh-credentials", "@deepseek-ai/dsh-tools"];
const targets = names.map((name) => {
  const path = dirname(req.resolve(`${name}/package.json`));
  const version = JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version;
  if (/^0\.1\./.test(version)) throw new Error(`${name}@${version} 太旧；请 --from 指向 DSH >=0.2.0-rc.2 的安装目录`);
  return { name, path, version };
});
let piManifest;
try {
  piManifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(source, "package.json")));
} catch (error) {
  if (!["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(error.code)) throw error;
  piManifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(req.resolve("@deepseek-ai/dsh-llm-pi-ai")));
}
const piRoot = dirname(piManifest);
targets.push({ name: "@earendil-works/pi-ai", path: piRoot, version: JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version });
for (const { name } of targets) {
  const destination = join(root, "node_modules", name);
  if (existsSync(destination) && !lstatSync(destination).isSymbolicLink()) throw new Error(`保留现有安装：${destination}`);
}
for (const { name, path, version } of targets) {
  const destination = join(root, "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { force: true });
  symlinkSync(realpathSync(path), destination, process.platform === "win32" ? "junction" : "dir");
  console.log(`${name}@${version} <- ${path}`);
}
