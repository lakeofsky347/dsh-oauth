import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const from = join(home, "profiles", "node_modules", "@deepseek-ai");
const dest = join(root, "node_modules", "@deepseek-ai");
mkdirSync(dest, { recursive: true });
for (const name of ["dsh-authorization", "dsh-credentials", "dsh-tools"]) {
  const target = join(dest, name);
  rmSync(target, { force: true });
  symlinkSync(join(from, name), target);
}
console.log(`linked peers from ${from}`);
