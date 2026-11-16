/** Read public release metadata. This command never installs, logs in, or changes a profile. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(await readFile(resolve(root, "upstreams.json"), "utf8"));
const checks = await Promise.all(Object.entries(baseline.packages).map(async ([name, expected]) => {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${name}: npm registry HTTP ${response.status}`);
  const body = await response.json();
  const tags = body["dist-tags"];
  const changed = Object.entries(expected).filter(([tag, version]) => tags[tag] !== version)
    .map(([tag, previous]) => ({ tag, previous, current: tags[tag] ?? null }));
  return { name, url, tags, changed };
}));
const report = { checkedAt: new Date().toISOString(), baselineDate: baseline.checkedOn, checks, needsReview: checks.some((row) => row.changed.length > 0) };
const outFlag = process.argv.indexOf("--out");
if (outFlag >= 0) {
  if (!process.argv[outFlag + 1]) throw new Error("--out 需要输出文件路径");
  const destination = resolve(process.argv[outFlag + 1]);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
if (report.needsReview) process.exitCode = 2;
