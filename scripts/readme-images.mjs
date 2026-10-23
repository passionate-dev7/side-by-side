// Fails when README.md links an image that is not in the repo.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const paths = [...readFileSync(join(root, "README.md"), "utf8").matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
const missing = paths.filter((p) => !existsSync(join(root, p)));
if (!paths.length) {
  console.error("README.md links no images");
  process.exit(1);
}
for (const p of missing) console.error(`missing ${p}`);
console.log(`${paths.length - missing.length} of ${paths.length} README images present`);
process.exit(missing.length ? 1 : 0);
