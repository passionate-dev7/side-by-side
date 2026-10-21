import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { eventLog, latencyOf, wireSteps, type LogRow } from "./log";
import type { Conn, Llm } from "./sim";

export const BUDGET_MS = 500;

function useLog(): readonly LogRow[] {
  return useSyncExternalStore(eventLog.subscribe, eventLog.getSnapshot);
}

const hhmmss = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const STEP_LABEL = { initialize: "initialize", "notifications/initialized": "initialized", "tools/list": "tools/list", "tools/call": "tools/call" } as const;

function Steps() {
  const rows = useLog();
  const steps = useMemo(() => wireSteps(rows), [rows]);
  if (!steps.length) return <p className="quiet">No MCP traffic yet.</p>;
  return (
    <ol className="steps" aria-label="MCP handshake and tool calls">
      {steps.map((s) => (
        <li key={s.id} className={s.status}>
          <span className="step-m">{STEP_LABEL[s.method]}</span>
          <span className="step-s">{s.subject}</span>
          <span className={`step-ms${s.method === "tools/call" && !s.formWait && (s.ms ?? 0) > BUDGET_MS ? " slow" : ""}`}>
            {s.status === "pending" ? "..." : s.ms === undefined ? "" : s.formWait ? `${s.ms} ms with form` : `${s.ms} ms`}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Handshake({ conn, llm }: { conn: Conn; llm: Llm }) {
  const ok = conn.status === "connected";
  return (
    <section className="panel" aria-label="Handshake">
      <h2>MCP handshake with the Side by Side server</h2>
      <dl className="stats">
        <Stat label="Protocol" value={ok ? (conn.protocolVersion ?? "") : "not negotiated"} />
        <Stat label="Server" value={ok ? `${conn.serverName}${conn.serverVersion ? ` ${conn.serverVersion}` : ""}` : "none"} />
        <Stat label="Tools" value={ok ? String(conn.toolCount ?? 0) : "0"} />
        <Stat label="Session" value={ok && conn.sessionId ? `${conn.sessionId.slice(0, 8)}...` : ok ? "stateless" : "none"} />
        <Stat label="Model" value={llm.status === "ready" ? `${llm.provider} / ${llm.model}` : "unavailable"} />
      </dl>
      <Steps />
    </section>
  );
}

function Meter({ label, p50, p95, max, count }: { label: string; p50: number | null; p95: number | null; max: number | null; count: number }) {
  const over = p95 !== null && p95 > BUDGET_MS;
  const pct = (v: number) => `${Math.min(100, (v / (BUDGET_MS * 1.2)) * 100)}%`;
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-n">{count} calls</span>
      </div>
      <div className="meter-nums">
        <span>p50 <b>{p50 === null ? "-" : `${p50} ms`}</b></span>
        <span>p95 <b className={over ? "bad" : ""}>{p95 === null ? "-" : `${p95} ms`}</b></span>
        <span>max <b>{max === null ? "-" : `${max} ms`}</b></span>
      </div>
      <div className="track" role="img" aria-label={`p95 ${p95 ?? "none"} milliseconds against a ${BUDGET_MS} millisecond budget`}>
        {p95 !== null ? <i className={`fill${over ? " bad" : ""}`} style={{ transform: `scaleX(${Math.min(1, p95 / (BUDGET_MS * 1.2))})` }} /> : null}
        <i className="mark" style={{ left: pct(BUDGET_MS) }} />
      </div>
      <div className="track-scale"><span>0</span><span style={{ left: pct(BUDGET_MS) }}>{BUDGET_MS} ms Alexa budget</span></div>
    </div>
  );
}

export function Latency() {
  const rows = useLog();
  const calls = useMemo(() => latencyOf(rows, (r) => r.source === "mcp" && r.label === "tools/call"), [rows]);
  const llm = useMemo(() => latencyOf(rows, (r) => r.source === "llm"), [rows]);
  return (
    <section className="panel" aria-label="Latency">
      <h2>Latency</h2>
      <Meter label="tools/call round trip" {...calls} />
      <p className="llm-line">
        Language model <b>{llm.count ? `p50 ${llm.p50} ms` : "no calls yet"}</b>
        {llm.count ? <span>, p95 {llm.p95} ms</span> : null}
      </p>
    </section>
  );
}

function Row({ r }: { r: LogRow }) {
  const [open, setOpen] = useState(false);
  const slow = r.source === "mcp" && r.label === "tools/call" && (r.ms ?? 0) > BUDGET_MS;
  return (
    <li className={`row ${r.status}`}>
      <button type="button" className="row-main" aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={!r.detail}>
        <time>{hhmmss(r.at)}</time>
        <span className={`src ${r.source}`}>{r.source}</span>
        <span className="lbl">
          {r.label}
          {r.note ? <em>{r.note}</em> : null}
        </span>
        <span className={`ms${slow ? " slow" : ""}`}>{r.status === "pending" ? "..." : r.ms !== undefined ? `${r.ms} ms` : ""}</span>
      </button>
      {open && r.detail ? <pre className="detail">{r.detail}</pre> : null}
    </li>
  );
}

export function WireLog() {
  const rows = useLog();
  const box = useRef<HTMLOListElement | null>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows]);
  return (
    <section className="panel log" aria-label="Event log">
      <div className="log-head">
        <h2>Wire</h2>
        <button type="button" className="ghost" onClick={() => eventLog.clear()}>Clear</button>
      </div>
      {rows.length ? (
        <ol className="rows" ref={box} onScroll={(e) => (stick.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 24)}>
          {rows.map((r) => (
            <Row key={r.id} r={r} />
          ))}
        </ol>
      ) : (
        <p className="quiet">Nothing sent yet. The first row will be initialize.</p>
      )}
    </section>
  );
}
