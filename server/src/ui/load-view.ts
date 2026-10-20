import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string>();

/** Reads a built MCP Apps view (server/ui-dist/<name>.html, produced by scripts/build-ui.mjs). */
export function loadView(name: string): string {
  let html = cache.get(name);
  if (!html) {
    html = readFileSync(fileURLToPath(new URL(`../../ui-dist/${name}.html`, import.meta.url)), "utf8");
    cache.set(name, html);
  }
  return html;
}
