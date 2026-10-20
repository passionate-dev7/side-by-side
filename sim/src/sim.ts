import type { CallToolResult, ElicitRequest, ElicitResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Msg, ToolCall, ToolResult } from "../server/llm";
import { mcpBackend, type Backend } from "./backend";
import { eventLog } from "./log";
import { connectMcp, resourceUriOf, textOf } from "./mcp";
import { modelTextOf, runTurn, systemPrompt, toToolDefs, LlmError } from "./orchestrator";
import { listen, recognitionSupported, speak, stopSpeaking, synthesisSupported, type Listener } from "./speech";
import { ViewHost, type DisplayMode, type HostContext } from "./viewhost";

export const DEFAULT_MCP_URL = "http://127.0.0.1:8787/mcp";
const URL_KEY = "sbs.mcpUrl";

export type Theme = "dark" | "light";
export type HostMode = DisplayMode | "voice-only";

export type Screen =
  | { kind: "home" }
  | { kind: "voice" }
  | { kind: "view"; prefersBorder: boolean }
  | { kind: "card"; tone: "data" | "error"; title: string; text: string; facts: Array<[string, string]> };

export interface ThreadItem {
  id: number;
  kind: "user" | "alexa" | "tool" | "error" | "info";
  text: string;
  status?: "pending" | "ok" | "error";
  ms?: number;
}

export interface Conn {
  status: "idle" | "connecting" | "connected" | "error";
  error?: string;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  sessionId?: string | null;
  toolCount?: number;
}

export interface Llm {
  status: "unknown" | "ready" | "none";
  provider?: string | null;
  model?: string | null;
  error?: string | null;
}

export interface ElicitState {
  params: ElicitRequest["params"];
  resolve(result: ElicitResult): void;
}

export interface SimState {
  url: string;
  conn: Conn;
  llm: Llm;
  theme: Theme;
  mode: HostMode;
  screen: Screen;
  thread: ThreadItem[];
  caption: { text: string; tone: "alexa" | "error" | "info" } | null;
  busy: boolean;
  listening: boolean;
  heard: string;
  speaking: boolean;
  muted: boolean;
  elicit: ElicitState | null;
  speechIn: boolean;
  speechOut: boolean;
}

type Listen = () => void;

const FACT_LIMIT = 6;

function humanize(key: string): string {
  const s = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function factsOf(sc: unknown): Array<[string, string]> {
  if (typeof sc !== "object" || sc === null || Array.isArray(sc)) return [];
  return Object.entries(sc as Record<string, unknown>)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .slice(0, FACT_LIMIT)
    .map(([k, v]) => [humanize(k), String(v)]);
}

class Sim {
  private state: SimState;
  private listeners = new Set<Listen>();
  private backend: Backend | null = null;
  private host: ViewHost | null = null;
  private slot: HTMLElement | null = null;
  private history: Msg[] = [];
  private seq = 0;
  private listener: Listener | null = null;
  private last: { tool: Tool; args: Record<string, unknown>; result: CallToolResult } | null = null;
  private presenting = Promise.resolve();

  constructor() {
    this.state = {
      url: new URLSearchParams(location.search).get("mcp") ?? localStorage.getItem(URL_KEY) ?? DEFAULT_MCP_URL,
      conn: { status: "idle" },
      llm: { status: "unknown" },
      theme: "dark",
      mode: "inline",
      screen: { kind: "home" },
      thread: [],
      caption: null,
      busy: false,
      listening: false,
      heard: "",
      speaking: false,
      muted: false,
      elicit: null,
      speechIn: recognitionSupported(),
      speechOut: synthesisSupported(),
    };
  }

  subscribe = (l: Listen): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): SimState => this.state;

  private set(patch: Partial<SimState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private push(item: Omit<ThreadItem, "id">): number {
    const id = ++this.seq;
    this.set({ thread: [...this.state.thread, { id, ...item }].slice(-60) });
    return id;
  }

  private patchItem(id: number, patch: Partial<ThreadItem>): void {
    this.set({ thread: this.state.thread.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  }

  setSlot(el: HTMLElement | null): void {
    this.slot = el;
  }

  setUrl(url: string): void {
    this.set({ url });
  }

  async loadLlmStatus(): Promise<void> {
    try {
      const res = await fetch("/api/llm/status");
      const body = (await res.json()) as { provider: string | null; model: string | null; error: string | null };
      this.set({ llm: { status: body.provider ? "ready" : "none", provider: body.provider, model: body.model, error: body.error } });
    } catch (e) {
      this.set({ llm: { status: "none", error: `LLM proxy unreachable: ${e instanceof Error ? e.message : String(e)}` } });
    }
  }

  // ---- connection ----

  async connect(): Promise<void> {
    await this.disconnect();
    const url = this.state.url.trim();
    localStorage.setItem(URL_KEY, url);
    this.set({ conn: { status: "connecting" } });
    const row = eventLog.add({ source: "sys", label: "connect", note: url });
    const t0 = performance.now();
    try {
      const conn = await connectMcp(url, {
        onElicit: (params) => this.askUser(params),
        onToolResult: (n, a, r) => this.remember(n, a, r),
        onClosed: (reason) => this.lost(reason),
      });
      this.backend = mcpBackend(conn);
      this.set({
        conn: { status: "connected", protocolVersion: conn.protocolVersion, serverName: conn.serverName, serverVersion: conn.serverVersion, sessionId: conn.sessionId, toolCount: conn.tools.length },
      });
      eventLog.update(row, { status: "ok", ms: Math.round(performance.now() - t0), note: `${url} (${this.backend.tools.length} tools)` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      eventLog.update(row, { status: "error", ms: Math.round(performance.now() - t0), detail: message });
      this.backend = null;
      this.set({ conn: { status: "error", error: message } });
      await this.showCard("error", "Can't connect", message, []);
    }
  }

  /** Newest tool result wins, so leaving voice-only restores what the family last saw, even if a view asked for it. */
  private remember(name: string, args: Record<string, unknown>, result: CallToolResult): void {
    const tool = this.backend?.tools.find((t) => t.name === name);
    if (tool && resourceUriOf(tool)) this.last = { tool, args, result };
  }

  private lost(reason: string): void {
    if (this.state.conn.status !== "connected") return;
    this.backend = null;
    this.set({ conn: { status: "error", error: reason } });
    void this.showCard("error", "Connection lost", reason, []);
  }

  async disconnect(): Promise<void> {
    const b = this.backend;
    this.backend = null;
    this.history = [];
    await this.dropView();
    this.set({ conn: { status: "idle" }, screen: { kind: "home" } });
    if (b) await b.close().catch(() => undefined);
  }

  // ---- device settings ----

  setTheme(theme: Theme): void {
    this.set({ theme });
    this.pushContext();
    document.documentElement.dataset.device = theme;
  }

  setMode(mode: HostMode): void {
    const from = this.state.mode;
    this.set({ mode });
    if (mode === "voice-only") {
      void this.dropView().then(() => this.set({ screen: { kind: "voice" } }));
    } else {
      this.pushContext();
      if (from === "voice-only" && this.last) void this.present(this.last.tool, this.last.args, this.last.result);
      else if (from === "voice-only") this.set({ screen: { kind: "home" } });
    }
  }

  toggleMute(): void {
    if (!this.state.muted) stopSpeaking();
    this.set({ muted: !this.state.muted });
  }

  private context(tool?: Tool): HostContext {
    return {
      theme: this.state.theme,
      displayMode: this.state.mode === "voice-only" ? "inline" : this.state.mode,
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { width: 768, height: 480 },
      platform: "web",
      locale: "en-US",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: "Alexa+ Simulator (web)",
      deviceCapabilities: { touch: true, hover: false },
      ...(tool ? { toolInfo: { tool } } : {}),
    };
  }

  private pushContext(): void {
    this.host?.setContext(this.context());
  }

  // ---- elicitation ----

  private askUser(params: ElicitRequest["params"]): Promise<ElicitResult> {
    if (this.state.elicit) return Promise.resolve({ action: "decline" });
    eventLog.add({ source: "sys", label: "elicitation shown", note: typeof params.message === "string" ? params.message.slice(0, 80) : undefined, status: "ok" });
    return new Promise<ElicitResult>((resolve) => {
      this.set({ elicit: { params, resolve: (r) => { this.set({ elicit: null }); resolve(r); } } });
    });
  }

  // ---- turns ----

  async submit(text: string): Promise<void> {
    const q = text.trim();
    if (!q || this.state.busy) return;
    stopSpeaking();
    if (!this.backend) {
      this.set({ caption: { text: "Not connected to an MCP server. Connect first, then ask again.", tone: "error" } });
      return;
    }
    if (this.state.llm.status !== "ready") await this.loadLlmStatus();
    if (this.state.llm.status !== "ready") {
      this.set({ caption: { text: `No language model is available. ${this.state.llm.error ?? ""}`.trim(), tone: "error" } });
      return;
    }
    const backend = this.backend;
    const mark = this.history.length;
    this.push({ kind: "user", text: q });
    this.set({ busy: true, caption: null, heard: "" });
    try {
      const outcome = await runTurn(this.history, q, {
        system: systemPrompt(new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })),
        tools: toToolDefs(backend.tools),
        model: this.state.llm.model ?? null,
        onToolStart: () => undefined,
        runTool: (call) => this.runTool(call),
      });
      if (!outcome.complete) this.fail("Stopped after six model calls without a final answer.", mark);
      else if (!outcome.text) this.fail("The model returned an empty reply.", mark);
      else {
        this.push({ kind: "alexa", text: outcome.text });
        this.set({ caption: { text: outcome.text, tone: "alexa" } });
        if (!this.state.muted) speak(outcome.text, { onStart: () => this.set({ speaking: true }), onEnd: () => this.set({ speaking: false }), onError: (m) => { this.push({ kind: "info", text: m }); eventLog.add({ source: "sys", label: "speech output", status: "error", detail: m }); } });
      }
    } catch (e) {
      this.fail(e instanceof LlmError ? `Language model error: ${e.message}` : e instanceof Error ? e.message : String(e), mark);
    } finally {
      this.set({ busy: false });
    }
  }

  private fail(message: string, mark: number): void {
    this.history.length = mark;
    this.push({ kind: "error", text: message });
    this.set({ caption: { text: message, tone: "error" } });
  }

  /** MCP 2025-11-25: a 404 on a session id means the server forgot it; start a new session with a fresh initialize. */
  private async recover(): Promise<Backend | null> {
    eventLog.add({ source: "sys", label: "session lost, starting a new one", status: "error" });
    const old = this.backend;
    this.backend = null;
    await this.dropView();
    if (old) await old.close().catch(() => undefined);
    try {
      const conn = await connectMcp(this.state.url.trim(), { onElicit: (p) => this.askUser(p), onToolResult: (n, a, r) => this.remember(n, a, r), onClosed: (r) => this.lost(r) });
      this.backend = mcpBackend(conn);
      this.set({ conn: { status: "connected", protocolVersion: conn.protocolVersion, serverName: conn.serverName, serverVersion: conn.serverVersion, sessionId: conn.sessionId, toolCount: conn.tools.length } });
      return this.backend;
    } catch (e) {
      this.set({ conn: { status: "error", error: e instanceof Error ? e.message : String(e) } });
      return null;
    }
  }

  private async runTool(call: ToolCall): Promise<ToolResult> {
    const id = this.push({ kind: "tool", text: call.name, status: "pending" });
    const t0 = performance.now();
    let backend = this.backend;
    let result: CallToolResult;
    try {
      if (!backend) throw new Error("Not connected to an MCP server.");
      try {
        result = await backend.callTool(call.name, call.arguments);
      } catch (e) {
        if (!/session not found|\b404\b/i.test(e instanceof Error ? e.message : String(e))) throw e;
        backend = await this.recover();
        if (!backend) throw e;
        result = await backend.callTool(call.name, call.arguments);
      }
    } catch (e) {
      result = { isError: true, content: [{ type: "text", text: `The tool call failed: ${e instanceof Error ? e.message : String(e)}` }] };
    }
    this.patchItem(id, { status: result.isError ? "error" : "ok", ms: Math.round(performance.now() - t0) });
    const tool = backend?.tools.find((t) => t.name === call.name);
    if (tool) await this.present(tool, call.arguments, result);
    else await this.showCard(result.isError ? "error" : "data", call.name, textOf(result), factsOf(result.structuredContent));
    return { id: call.id, name: call.name, text: modelTextOf(result), isError: result.isError === true };
  }

  // ---- presenting a tool result ----

  /** Serialised so two results arriving close together mount in order. */
  present(tool: Tool, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
    this.presenting = this.presenting.then(() => this.presentNow(tool, args, result)).catch((e) => {
      eventLog.add({ source: "sys", label: "present failed", status: "error", detail: e instanceof Error ? e.message : String(e) });
    });
    return this.presenting;
  }

  private async presentNow(tool: Tool, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
    this.last = { tool, args, result };
    const uri = resourceUriOf(tool);
    if (this.state.mode === "voice-only") {
      await this.dropView();
      this.set({ screen: { kind: "voice" } });
      return;
    }
    if (result.isError || !uri) {
      await this.showCard(result.isError ? "error" : "data", result.isError ? "That did not work" : tool.title ?? humanize(tool.name), textOf(result), result.isError ? [] : factsOf(result.structuredContent));
      return;
    }
    if (this.host && this.host.uri === uri && this.state.screen.kind === "view") {
      this.host.push(args, result);
      return;
    }
    await this.dropView();
    const backend = this.backend;
    const slot = this.slot;
    if (!backend || !slot) throw new Error("The device screen is not ready.");
    const row = eventLog.add({ source: "view", label: "mount view", note: uri });
    try {
      const { html, prefersBorder } = await backend.readResource(uri);
      this.host = new ViewHost(
        uri,
        backend,
        slot,
        this.context(tool),
        {
          onDisplayModeRequest: (mode) => {
            const applied: DisplayMode = mode === "fullscreen" ? "fullscreen" : "inline";
            if (this.state.mode !== "voice-only") {
              this.set({ mode: applied });
              this.pushContext();
            }
            return applied;
          },
          onOpenLink: (url) => {
            try {
              const u = new URL(url);
              if (u.protocol !== "https:" && u.protocol !== "http:") return false;
              window.open(u.href, "_blank", "noopener,noreferrer");
              return true;
            } catch {
              return false;
            }
          },
          onUserMessage: (text) => void this.submit(text),
        },
        { args, result },
      );
      this.set({ screen: { kind: "view", prefersBorder } });
      await this.host.start(html);
      eventLog.update(row, { status: "ok" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      eventLog.update(row, { status: "error", detail: message });
      await this.dropView();
      await this.showCard("error", "The screen did not load", message, []);
    }
  }

  private async showCard(tone: "data" | "error", title: string, text: string, facts: Array<[string, string]>): Promise<void> {
    await this.dropView();
    this.set({ screen: { kind: "card", tone, title, text, facts } });
  }

  private async dropView(): Promise<void> {
    const h = this.host;
    this.host = null;
    if (h) await h.dispose();
  }

  // ---- voice in ----

  toggleListening(): void {
    if (this.state.listening) {
      this.listener?.stop();
      return;
    }
    stopSpeaking();
    this.set({ listening: true, heard: "", caption: null });
    this.listener = listen({
      onInterim: (t) => this.set({ heard: t }),
      onFinal: (t) => {
        this.set({ heard: t });
        void this.submit(t);
      },
      onError: (m) => {
        this.set({ caption: { text: m, tone: "error" } });
        eventLog.add({ source: "sys", label: "speech input", status: "error", detail: m });
      },
      onEnd: () => {
        this.listener = null;
        this.set({ listening: false });
      },
    });
    if (!this.listener) this.set({ listening: false });
  }

  get tools(): Tool[] {
    return this.backend?.tools ?? [];
  }
}

export const sim = new Sim();
