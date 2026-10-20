// Bundles every src/ui/<view>/ (index.html + view.ts) into one self-contained ui-dist/<view>.html.
import { build } from "esbuild";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const uiSrc = join(root, "src/ui");
const out = join(root, "ui-dist");
mkdirSync(out, { recursive: true });

for (const name of readdirSync(uiSrc).filter((n) => statSync(join(uiSrc, n)).isDirectory())) {
  const js = await build({
    entryPoints: [join(uiSrc, name, "view.ts")],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    minify: true,
    legalComments: "none",
  });
  const html = readFileSync(join(uiSrc, name, "index.html"), "utf8");
  if (!html.includes("<!--SCRIPT-->")) throw new Error(`${name}/index.html has no <!--SCRIPT--> marker`);
  const script = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  writeFileSync(join(out, `${name}.html`), html.replace("<!--SCRIPT-->", () => `<script>${script}</script>`));
  console.log(`built ui-dist/${name}.html`);
}
