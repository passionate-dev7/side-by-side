/**
 * Turns a model reply into text that is safe to read aloud and to show as the Alexa caption. The system prompt asks
 * for plain sentences, but models still emit markdown, so this runs on every reply in code.
 */

const END = /[.!?:;]$/;
const LIST_ITEM = /^\s{0,6}(?:[-*+•◦]|\d{1,3}[.)])\s+/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function line(raw: string): string | null {
  let l = raw;
  if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(l)) return null;
  if (TABLE_RULE.test(l) && l.includes("-") && l.includes("|")) return null;
  l = l.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s*>+\s?/, "");
  if (/^\s*\|.*\|\s*$/.test(l)) l = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
  const item = LIST_ITEM.test(l);
  l = l.replace(LIST_ITEM, "").trim();
  if (!l) return null;
  return item && !END.test(l) ? `${l}.` : l;
}

export function speakable(text: string): string {
  let t = text.replace(/\r\n?/g, "\n");
  t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, "$1").replace(/```/g, "");
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<(https?:[^>\s]+)>/g, "$1");
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  t = t
    .split("\n")
    .map(line)
    .filter((l): l is string => l !== null)
    .join(" ");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  t = t.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1").replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1");
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  t = t.replace(/\\([\\`*_{}\[\]()#+\-.!|>~$])/g, "$1");
  t = t.replace(/[\p{Extended_Pictographic}️‍]/gu, "");
  return t.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
}
