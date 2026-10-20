/** Turns an MCP elicitation `requestedSchema` (flat JSON Schema object) into form fields, validates, and builds `content`. */

export type FieldKind = "text" | "date" | "email" | "datetime" | "uri" | "number" | "boolean" | "select" | "multi";
export type FieldValue = string | number | boolean | string[];

export interface Option {
  value: string;
  label: string;
}

export interface Field {
  key: string;
  title: string;
  description?: string;
  required: boolean;
  kind: FieldKind;
  options?: Option[];
  min?: number;
  max?: number;
  integer?: boolean;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  initial: string | boolean | string[];
}

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function humanize(key: string): string {
  const s = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function optionsOf(s: Schema): Option[] | undefined {
  const names = Array.isArray(s.enumNames) ? s.enumNames : undefined;
  if (Array.isArray(s.enum)) return s.enum.map((v, i) => ({ value: String(v), label: String(names?.[i] ?? v) }));
  const list = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : undefined;
  if (list && list.every((o) => isObj(o) && "const" in o)) return list.map((o) => ({ value: String((o as Schema).const), label: String((o as Schema).title ?? (o as Schema).const) }));
  return undefined;
}

export function fieldsOf(requestedSchema: unknown): Field[] {
  if (!isObj(requestedSchema) || !isObj(requestedSchema.properties)) return [];
  const required = new Set(Array.isArray(requestedSchema.required) ? (requestedSchema.required as unknown[]).map(String) : []);
  return Object.entries(requestedSchema.properties).flatMap(([key, raw]): Field[] => {
    if (!isObj(raw)) return [];
    const base = { key, title: str(raw.title) ?? humanize(key), description: str(raw.description), required: required.has(key) };
    const type = str(raw.type);
    if (type === "boolean") return [{ ...base, kind: "boolean" as const, initial: raw.default === true }];
    if (type === "number" || type === "integer")
      return [{ ...base, kind: "number" as const, min: num(raw.minimum), max: num(raw.maximum), integer: type === "integer", initial: raw.default === undefined ? "" : String(raw.default) }];
    if (type === "array") {
      const items = isObj(raw.items) ? raw.items : {};
      const options = optionsOf(items) ?? [];
      return [{ ...base, kind: "multi" as const, options, minItems: num(raw.minItems), maxItems: num(raw.maxItems), initial: Array.isArray(raw.default) ? raw.default.map(String) : [] }];
    }
    const options = optionsOf(raw);
    if (options) return [{ ...base, kind: "select" as const, options, initial: raw.default === undefined ? "" : String(raw.default) }];
    const format = str(raw.format);
    const kind: FieldKind = format === "date" ? "date" : format === "email" ? "email" : format === "date-time" ? "datetime" : format === "uri" ? "uri" : "text";
    return [{ ...base, kind, minLength: num(raw.minLength), maxLength: num(raw.maxLength), initial: raw.default === undefined ? "" : String(raw.default) }];
  });
}

export type Values = Record<string, string | boolean | string[]>;

export function initialValues(fields: Field[]): Values {
  return Object.fromEntries(fields.map((f) => [f.key, f.initial]));
}

export function validate(fields: Field[], values: Values): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    const empty = v === "" || v === undefined || (Array.isArray(v) && v.length === 0);
    if (f.kind === "boolean") continue;
    if (empty) {
      if (f.required) errors[f.key] = "This is required.";
      continue;
    }
    if (f.kind === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[f.key] = "Enter a number.";
      else if (f.integer && !Number.isInteger(n)) errors[f.key] = "Enter a whole number.";
      else if (f.min !== undefined && n < f.min) errors[f.key] = `At least ${f.min}.`;
      else if (f.max !== undefined && n > f.max) errors[f.key] = `At most ${f.max}.`;
    } else if (f.kind === "multi") {
      const n = (v as string[]).length;
      if (f.minItems !== undefined && n < f.minItems) errors[f.key] = `Pick at least ${f.minItems}.`;
      else if (f.maxItems !== undefined && n > f.maxItems) errors[f.key] = `Pick at most ${f.maxItems}.`;
    } else if (typeof v === "string") {
      if (f.minLength !== undefined && v.length < f.minLength) errors[f.key] = `At least ${f.minLength} characters.`;
      else if (f.maxLength !== undefined && v.length > f.maxLength) errors[f.key] = `At most ${f.maxLength} characters.`;
      else if (f.kind === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errors[f.key] = "Enter an email address.";
      else if (f.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f.key] = "Enter a date.";
      else if (f.kind === "uri") {
        try {
          new URL(v);
        } catch {
          errors[f.key] = "Enter a full web address.";
        }
      }
    }
  }
  return errors;
}

export function contentOf(fields: Field[], values: Values): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.kind === "boolean") out[f.key] = v === true;
    else if (f.kind === "number") {
      if (v !== "" && v !== undefined) out[f.key] = Number(v);
    } else if (f.kind === "multi") {
      if (Array.isArray(v) && v.length) out[f.key] = v;
    } else if (typeof v === "string" && v !== "") out[f.key] = v;
  }
  return out;
}
