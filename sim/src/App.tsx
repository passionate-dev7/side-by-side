import { useEffect, useMemo, useState } from "react";
import { Device, useSim } from "./Device";
import { Handshake, Latency, WireLog } from "./Wire";
import { sim, type HostMode, type SimState, type Theme } from "./sim";

const PROMPTS = [
  "We are Dad 40, Mum 38, Mia 6 and Leo 9. Find flights from BOS to MCO on 2026-11-25, kids next to us.",
  "Show me the seats on the best one.",
  "Book that one.",
  "Are we still sitting together?",
];

const MODES: Array<[HostMode, string]> = [
  ["inline", "Inline"],
  ["fullscreen", "Fullscreen"],
  ["voice-only", "Voice only"],
];

function Segmented<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: Array<[T, string]>; onPick(v: T): void }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function ConnectionBar({ state }: { state: SimState }) {
  const { conn } = state;
  const word = conn.status === "connected" ? "Connected" : conn.status === "connecting" ? "Connecting" : conn.status === "error" ? "Not connected" : "Idle";
  return (
    <form
      className="conn"
      onSubmit={(e) => {
        e.preventDefault();
        void sim.connect();
      }}
    >
      <label htmlFor="mcp-url">MCP server</label>
      <input id="mcp-url" type="url" value={state.url} spellCheck={false} onChange={(e) => sim.setUrl(e.target.value)} />
      <button type="submit" className="solid" disabled={conn.status === "connecting"}>
        {conn.status === "connected" ? "Reconnect" : "Connect"}
      </button>
      <span className={`pill ${conn.status}`} role="status">
        {word}
      </span>
      {conn.status === "error" && conn.error ? <p className="conn-err" role="alert">{conn.error}</p> : null}
    </form>
  );
}

function Caption({ state }: { state: SimState }) {
  const lastUser = [...state.thread].reverse().find((t) => t.kind === "user");
  const turnStart = lastUser ? state.thread.indexOf(lastUser) : 0;
  const tools = state.thread.slice(turnStart).filter((t) => t.kind === "tool");
  const extras = state.thread.slice(turnStart).filter((t) => t.kind === "info");
  return (
    <section className="caption" aria-live="polite" aria-label="Alexa response">
      {state.listening ? <p className="heard">Listening{state.heard ? `: ${state.heard}` : ""}</p> : lastUser ? <p className="heard">You said: {lastUser.text}</p> : <p className="heard">Ask by voice or type below.</p>}
      {tools.length ? (
        <ul className="tools" aria-label="Tools called this turn">
          {tools.map((t) => (
            <li key={t.id} className={t.status}>
              <span>{t.text}</span>
              <b>{t.status === "pending" ? "..." : `${t.ms} ms`}</b>
            </li>
          ))}
        </ul>
      ) : null}
      {state.busy && !state.caption ? <p className="said thinking">Thinking</p> : null}
      {state.caption ? <p className={`said ${state.caption.tone}`}>{state.caption.text}</p> : null}
      {extras.map((t) => (
        <p key={t.id} className="aside">{t.text}</p>
      ))}
    </section>
  );
}

function Composer({ state }: { state: SimState }) {
  const [text, setText] = useState("");
  const send = (q: string) => {
    if (!q.trim()) return;
    void sim.submit(q);
    setText("");
  };
  return (
    <section className="composer" aria-label="Ask Alexa">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <button type="button" className={`mic${state.listening ? " on" : ""}`} onClick={() => sim.toggleListening()} disabled={!state.speechIn} aria-pressed={state.listening}>
          {state.listening ? "Stop" : "Speak"}
        </button>
        <input type="text" value={text} placeholder="Type what you would say to Alexa" aria-label="Ask Alexa" autoComplete="off" onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="solid" disabled={state.busy || !text.trim()}>
          Send
        </button>
      </form>
      {!state.speechIn ? <p className="aside">Speech recognition is not available in this browser. Typing works the same way.</p> : null}
      <ul className="prompts" aria-label="Example requests">
        {PROMPTS.map((p) => (
          <li key={p}>
            <button type="button" title={p} disabled={state.busy} onClick={() => send(p)}>
              {p}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Demo day controls: appear when the connected server can play the airline. `?autorun=1` starts the run once connected. */
function DemoControls({ state }: { state: SimState }) {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState("");
  const origin = useMemo(() => {
    try {
      return new URL(state.url).origin;
    } catch {
      return null;
    }
  }, [state.url]);
  useEffect(() => {
    setOn(false);
    if (!origin) return;
    let live = true;
    fetch(`${origin}/fixture`).then((r) => r.json()).then((b: { fixture?: boolean }) => live && setOn(b.fixture === true), () => live && setOn(false));
    return () => void (live = false);
  }, [origin]);
  const auto = useMemo(() => new URLSearchParams(location.search).get("autorun") === "1", []);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (auto && on && !started && state.conn.status === "connected") {
      setStarted(true);
      void sim.runDemo();
    }
  }, [auto, on, started, state.conn.status]);
  if (!on || !origin) return null;
  const { running, step, total } = state.demo;
  return (
    <div className="fixture" role="group" aria-label="Demo controls">
      <span className="tagline">Demo day</span>
      {running ? (
        <>
          <span className="demo-step" role="status">Step {step} of {total}</span>
          <button type="button" onClick={() => sim.stopDemo()}>Stop</button>
        </>
      ) : (
        <button type="button" className="solid" disabled={state.conn.status !== "connected"} onClick={() => void sim.runDemo()}>Run the demo, about 80 seconds</button>
      )}
      <button
        type="button"
        disabled={running}
        onClick={async () => {
          const r = await fetch(`${origin}/fixture/airline-moves-seat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          const b = (await r.json()) as { moved?: string; from?: string | null; to?: string; error?: string };
          setNote(r.ok ? `The airline moved ${b.moved} from ${b.from ?? "no seat"} to ${b.to}. Now ask: are we still sitting together?` : (b.error ?? "The demo airline refused."));
        }}
      >
        The airline moves a child
      </button>
      {note ? <span className="fixture-note" role="status">{note}</span> : null}
    </div>
  );
}

export function App() {
  const state = useSim();
  useEffect(() => {
    void sim.loadLlmStatus();
    void sim.connect();
    return () => void sim.disconnect();
  }, []);
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <h1>Side by Side on Echo Show</h1>
          <span>Family flights with every child beside an adult. MCP client, MCP Apps view, voice in and out.</span>
        </div>
        <ConnectionBar state={state} />
      </header>
      <main className="stage">
        <div className="toolbar">
          <Segmented<HostMode> label="Display mode" value={state.mode} options={MODES} onPick={(m) => sim.setMode(m)} />
          <Segmented<Theme> label="Device theme" value={state.theme} options={[["dark", "Dark"], ["light", "Light"]]} onPick={(t) => sim.setTheme(t)} />
          <Segmented<"on" | "off"> label="Spoken replies" value={state.muted ? "off" : "on"} options={[["on", "Sound on"], ["off", "Muted"]]} onPick={(v) => (v === "off") !== state.muted && sim.toggleMute()} />
        </div>
        <DemoControls state={state} />
        <Device state={state} />
        <Caption state={state} />
        <Composer state={state} />
      </main>
      <aside className="rail">
        <Handshake conn={state.conn} llm={state.llm} />
        <Latency />
        <WireLog />
      </aside>
    </div>
  );
}
