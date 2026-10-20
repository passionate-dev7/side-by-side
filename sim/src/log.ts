export type LogSource = "mcp" | "llm" | "view" | "sys";
export type LogStatus = "pending" | "ok" | "error";

export interface LogRow {
  id: number;
  at: number;
  source: LogSource;
  label: string;
  /** Short context: tool name, protocol version, model. Never a credential. */
  note?: string;
  ms?: number;
  /** True when the time includes a human filling in a form, so it says nothing about server speed. */
  excluded?: boolean;
  status: LogStatus;
  detail?: string;
}

type Listener = () => void;

/** Append-only event log with in-place updates for requests still in flight. Snapshot identity changes on every write. */
class EventLog {
  private rows: LogRow[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  private snapshot: readonly LogRow[] = [];

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): readonly LogRow[] => this.snapshot;

  add(row: Omit<LogRow, "id" | "at" | "status"> & { status?: LogStatus }): number {
    const id = ++this.seq;
    this.rows.push({ id, at: Date.now(), status: "pending", ...row });
    if (this.rows.length > 400) this.rows.splice(0, this.rows.length - 400);
    this.publish();
    return id;
  }

  update(id: number, patch: Partial<Omit<LogRow, "id" | "at">>): void {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return;
    this.rows[i] = { ...this.rows[i], ...patch };
    this.publish();
  }

  clear(): void {
    this.rows = [];
    this.publish();
  }

  private publish(): void {
    this.snapshot = [...this.rows];
    this.listeners.forEach((l) => l());
  }
}

export const eventLog = new EventLog();

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface Latency {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function latencyOf(rows: readonly LogRow[], match: (r: LogRow) => boolean): Latency {
  const ms = rows
    .filter((r) => r.status !== "pending" && r.ms !== undefined && !r.excluded && match(r))
    .map((r) => r.ms as number)
    .sort((a, b) => a - b);
  return { count: ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95), max: ms.length ? ms[ms.length - 1] : null };
}
