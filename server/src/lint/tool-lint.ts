import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Tool-poisoning lint for MCP servers (basis: MCPTox, arXiv 2508.14925, where poisoned tool descriptions reached a
 * 72.8% attack success rate). It scans every model-facing string a server advertises: tool names, titles and
 * descriptions, every description inside each input schema, and resource names, titles and descriptions.
 * Resource bodies (the sandboxed HTML views) are not model-facing and are not scanned.
 */

export interface Finding {
  where: string;
  rule: string;
  excerpt: string;
}

export const MAX_DESCRIPTION = 300;

const RULES: Array<{ rule: string; test: RegExp }> = [
  { rule: "imperative-to-model", test: /\b(ignore|disregard|override|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.]{0,30}\b(instructions?|rules?|messages?)\b/i },
  { rule: "imperative-to-model", test: /\balways (call|use|invoke|run|include|pass|send)\b/i },
  { rule: "imperative-to-model", test: /\bbefore (using|calling|running|invoking) (this|any|the|every)\b/i },
  { rule: "imperative-to-model", test: /\b(do not|don't|never) (tell|mention|reveal|disclose|inform|show|let)\b[^.]{0,30}\b(user|human|customer)\b/i },
  { rule: "imperative-to-model", test: /\byou (must|should always|are required to|have to)\b/i },
  { rule: "imperative-to-model", test: /<\s*(important|system|instructions?)\s*>/i },
  { rule: "imperative-to-model", test: /\b(system prompt|new instructions)\b/i },
  { rule: "url", test: /\bhttps?:\/\/|\bwww\.\w|\bftp:\/\//i },
  { rule: "file-path", test: /(~\/|\/etc\/|\/home\/|\/Users\/|\/var\/|\/tmp\/|\b[A-Za-z]:\\|\.\.\/|\.ssh\b|\bid_rsa\b|\.env\b|\bcredentials\b)/ },
  { rule: "secret-pattern", test: /(\b(api[_-]?key|secret|password|passwd|bearer|access[_-]?token)\b\s*[:=])|\bAKIA[0-9A-Z]{16}\b|\b(sk|pk|ghp|xox[bp])[-_][A-Za-z0-9_-]{16,}|\bduffel_(test|live)_[A-Za-z0-9_-]+/i },
  { rule: "other-tool-or-server", test: /\b(another|other|different|second) (tool|server|mcp)\b|\bcall (the )?\w+ tool\b|\buse (the )?\w+ (server|tool)\b/i },
  { rule: "hidden-characters", test: /[\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/u },
];

export function lintText(where: string, text: string | undefined, otherToolNames: string[] = []): Finding[] {
  if (!text) return [];
  const out: Finding[] = [];
  for (const { rule, test } of RULES) {
    const m = test.exec(text);
    if (m) out.push({ where, rule, excerpt: m[0].slice(0, 60) });
  }
  for (const name of otherToolNames) {
    if (new RegExp(`\\b${name}\\b`).test(text)) out.push({ where, rule: "other-tool-or-server", excerpt: name });
  }
  if (text.length > MAX_DESCRIPTION) out.push({ where, rule: "too-long", excerpt: `${text.length} chars` });
  return out;
}

function schemaDescriptions(schema: unknown, path: string, acc: Array<[string, string]> = []): Array<[string, string]> {
  if (!schema || typeof schema !== "object") return acc;
  const node = schema as Record<string, unknown>;
  if (typeof node.description === "string") acc.push([path, node.description]);
  if (typeof node.title === "string") acc.push([`${path}.title`, node.title]);
  for (const key of ["properties", "$defs", "definitions"]) {
    const group = node[key];
    if (group && typeof group === "object") for (const [k, v] of Object.entries(group)) schemaDescriptions(v, `${path}.${k}`, acc);
  }
  for (const key of ["items", "additionalProperties"]) schemaDescriptions(node[key], `${path}[]`, acc);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const arr = node[key];
    if (Array.isArray(arr)) arr.forEach((v, i) => schemaDescriptions(v, `${path}|${i}`, acc));
  }
  if (Array.isArray(node.enum)) acc.push([`${path}.enum`, node.enum.filter((e) => typeof e === "string").join(" ")]);
  return acc;
}

export interface LintReport {
  tools: number;
  resources: number;
  stringsScanned: number;
  findings: Finding[];
}

export async function lintServer(client: Client): Promise<LintReport> {
  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  const names = tools.map((t) => t.name);
  const findings: Finding[] = [];
  let stringsScanned = 0;
  const scan = (where: string, text: string | undefined, others: string[] = []) => {
    if (text === undefined) return;
    stringsScanned++;
    findings.push(...lintText(where, text, others));
  };

  for (const t of tools) {
    const others = names.filter((n) => n !== t.name);
    scan(`tool ${t.name} name`, t.name);
    scan(`tool ${t.name} title`, t.title, others);
    scan(`tool ${t.name} description`, t.description, others);
    for (const [path, text] of schemaDescriptions(t.inputSchema, `tool ${t.name} input`)) scan(path, text, others);
    for (const [path, text] of schemaDescriptions(t.outputSchema, `tool ${t.name} output`)) scan(path, text, others);
  }
  for (const r of resources) {
    scan(`resource ${r.uri} name`, r.name);
    scan(`resource ${r.uri} title`, r.title);
    scan(`resource ${r.uri} description`, r.description);
  }
  return { tools: tools.length, resources: resources.length, stringsScanned, findings };
}
