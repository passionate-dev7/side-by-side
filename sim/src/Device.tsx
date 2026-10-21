import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { contentOf, fieldsOf, initialValues, validate, type Field, type Values } from "./elicit";
import { sim, type ElicitState, type SimState } from "./sim";

const W = 768;
const H = 480;
const BEZEL = 22;
const MAX_SCALE = 1.667; // Echo Show 8/15 root scale

function useStageScale(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(Math.max(0.3, Math.min(MAX_SCALE, (el.clientWidth - BEZEL * 2) / W)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, scale];
}

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Home() {
  const now = useClock();
  return (
    <div className="home">
      <div className="home-time">{now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</div>
      <div className="home-date">{now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
    </div>
  );
}

function NativeCard({ screen }: { screen: Extract<SimState["screen"], { kind: "card" }> }) {
  return (
    <section className={`native ${screen.tone}`} aria-live="polite">
      <header>
        <h2>{screen.title}</h2>
        <span className="native-tag">{screen.tone === "error" ? "Problem" : "Data only"}</span>
      </header>
      {screen.text ? <p className="native-text">{screen.text}</p> : null}
      {screen.facts.length ? (
        <dl className="native-facts">
          {screen.facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function FieldInput({ f, value, error, onChange }: { f: Field; value: Values[string]; error?: string; onChange: (v: Values[string]) => void }) {
  const id = `el-${f.key}`;
  let control: React.ReactNode;
  if (f.kind === "boolean") {
    control = (
      <label className="el-switch">
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span>{value === true ? "Yes" : "No"}</span>
      </label>
    );
  } else if (f.kind === "select") {
    const options = f.options ?? [];
    control =
      options.length <= 4 ? (
        <div className="el-seg" role="radiogroup" aria-labelledby={`${id}-l`}>
          {options.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(value === o.value && !f.required ? "" : o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
  } else if (f.kind === "multi") {
    const picked = Array.isArray(value) ? value : [];
    control = (
      <div className="el-seg" role="group" aria-labelledby={`${id}-l`}>
        {(f.options ?? []).map((o) => (
          <button key={o.value} type="button" aria-pressed={picked.includes(o.value)} onClick={() => onChange(picked.includes(o.value) ? picked.filter((x) => x !== o.value) : [...picked, o.value])}>
            {o.label}
          </button>
        ))}
      </div>
    );
  } else {
    const type = f.kind === "date" ? "date" : f.kind === "email" ? "email" : f.kind === "datetime" ? "datetime-local" : f.kind === "uri" ? "url" : f.kind === "number" ? "number" : "text";
    control = (
      <input
        id={id}
        type={type}
        value={String(value)}
        min={f.kind === "number" ? f.min : undefined}
        max={f.kind === "number" ? f.max : undefined}
        step={f.kind === "number" && f.integer ? 1 : undefined}
        maxLength={f.maxLength}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className={`el-field${error ? " bad" : ""}`}>
      <label id={`${id}-l`} htmlFor={id}>
        {f.title}
        {f.required ? "" : " (optional)"}
      </label>
      {control}
      {error ? <p className="el-err" role="alert">{error}</p> : f.description ? <p className="el-help">{f.description}</p> : null}
    </div>
  );
}

function Elicitation({ ask }: { ask: ElicitState }) {
  const fields = fieldsOf((ask.params as { requestedSchema?: unknown }).requestedSchema);
  const [values, setValues] = useState<Values>(() => initialValues(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const first = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    first.current?.querySelector<HTMLElement>("input, select, button")?.focus();
  }, []);
  const accept = () => {
    const errs = validate(fields, values);
    setErrors(errs);
    if (Object.keys(errs).length === 0) ask.resolve({ action: "accept", content: contentOf(fields, values) });
  };
  return (
    <div
      className="el-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="el-msg"
      onKeyDown={(e) => {
        if (e.key === "Escape") ask.resolve({ action: "cancel" });
      }}
    >
      <form
        className="el-card"
        onSubmit={(e) => {
          e.preventDefault();
          accept();
        }}
      >
        <p id="el-msg" className="el-msg">{ask.params.message}</p>
        <div className="el-fields" ref={first}>
          {fields.map((f) => (
            <FieldInput key={f.key} f={f} value={values[f.key]} error={errors[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
          ))}
        </div>
        <div className="el-actions">
          <button type="button" className="el-decline" onClick={() => ask.resolve({ action: "decline" })}>Decline</button>
          <button type="submit" className="el-accept">Accept</button>
        </div>
      </form>
    </div>
  );
}

export function Device({ state }: { state: SimState }) {
  const [ref, scale] = useStageScale();
  const slotRef = useCallback((el: HTMLDivElement | null) => sim.setSlot(el), []);
  const { screen, mode, theme } = state;
  const lit = state.listening ? "listening" : state.speaking ? "speaking" : state.busy ? "thinking" : "idle";
  const showView = screen.kind === "view";
  return (
    <div className="device-wrap" ref={ref}>
      <div className="echo" data-mode={mode} style={{ padding: BEZEL, borderRadius: BEZEL + 8 }}>
        <span className="cam" aria-hidden="true" />
        <div className="glass" style={{ width: W * scale, height: H * scale }}>
          <div className="canvas" data-theme={theme} data-mode={mode} data-screen={screen.kind} style={{ width: W, height: H, transform: `scale(${scale})` }}>
            <div className="ambient"><Home /></div>
            <div
              className={`view-slot ${mode === "fullscreen" ? "full" : "inline"}${screen.kind === "view" && !screen.prefersBorder ? " borderless" : ""}`}
              ref={slotRef}
              hidden={!showView}
            />
            {screen.kind === "card" ? <NativeCard screen={screen} /> : null}
            {state.elicit ? <Elicitation key={JSON.stringify(state.elicit.params)} ask={state.elicit} /> : null}
          </div>
        </div>
        <div className={`lightbar ${lit}`} aria-hidden="true" />
      </div>
      <p className="device-note" aria-live="polite">
        {mode === "voice-only" ? "Voice-only: no screen. The caption below is all there is." : `Simulated Echo Show. Display ${mode}, ${W} x ${H} canvas at ${scale.toFixed(2)}x`}
      </p>
    </div>
  );
}

export function useSim(): SimState {
  return useSyncExternalStore(sim.subscribe, sim.getSnapshot);
}
