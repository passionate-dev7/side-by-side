// Bundles every src/ui/<view>/ (index.html + view.ts) into one self-contained ui-dist/<view>.html.
import { build } from "esbuild";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";

const MIME = { ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".svg": "image/svg+xml" };

/** Replaces {{asset:file}} in a view's index.html with a data: URI of src/ui/<view>/file, so the sandboxed iframe needs no network. */
function inlineAssets(html, dir, view) {
  return html.replace(/\{\{asset:([\w.-]+)\}\}/g, (_, file) => {
    const type = MIME[extname(file)];
    if (!type) throw new Error(`${view}: no MIME type for asset ${file}`);
    return `data:${type};base64,${readFileSync(join(dir, file)).toString("base64")}`;
  });
}

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
  const html = inlineAssets(readFileSync(join(uiSrc, name, "index.html"), "utf8"), join(uiSrc, name), name);
  if (!html.includes("<!--SCRIPT-->")) throw new Error(`${name}/index.html has no <!--SCRIPT--> marker`);
  const script = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  writeFileSync(join(out, `${name}.html`), html.replace("<!--SCRIPT-->", () => `<script>${script}</script>`));
  console.log(`built ui-dist/${name}.html`);
}
