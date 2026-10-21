import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Backend } from "./backend";
import { eventLog } from "./log";

export type DisplayMode = "inline" | "fullscreen";

export interface HostContext {
  [key: string]: unknown;
  theme: "dark" | "light";
  displayMode: DisplayMode;
  availableDisplayModes: DisplayMode[];
  containerDimensions: { width: number; height: number };
  platform: "web";
  locale: string;
  timeZone: string;
  userAgent: string;
  deviceCapabilities: { touch: boolean; hover: boolean };
}

export interface HostCallbacks {
  /** Returns the mode actually applied. */
  onDisplayModeRequest(mode: string): DisplayMode;
  onOpenLink(url: string): boolean;
  /** The view asked the host to post a message as the user. */
  onUserMessage(text: string): void;
}

interface Payload {
  args: Record<string, unknown>;
  result: CallToolResult;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One MCP Apps view in a sandboxed iframe, bridged with AppBridge over postMessage.
 * The bridge is connected before the document loads; tool input and result are sent from oninitialized.
 */
export class ViewHost {
  readonly iframe: HTMLIFrameElement;
  private readonly bridge: AppBridge;
  private ready = false;
  private latest: Payload;
  private disposed = false;

  constructor(
    readonly uri: string,
    backend: Backend,
    private readonly slot: HTMLElement,
    context: HostContext,
    private readonly cb: HostCallbacks,
    first: Payload,
  ) {
    this.latest = first;
    this.iframe = document.createElement("iframe");
    this.iframe.className = "view-frame";
    this.iframe.title = "Alexa+ screen";
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.width = "768";
    this.iframe.height = "480";
    this.bridge = new AppBridge(
      backend.client,
      { name: "Side by Side on Echo Show", version: "0.1.0" },
      { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, message: { text: {} } },
      { hostContext: context },
    );
    const note = (label: string, detail?: string, status: "ok" | "error" = "ok") => eventLog.add({ source: "view", label, detail, status });

    this.bridge.oninitialized = () => {
      this.ready = true;
      note("view initialized", `${this.uri}`);
      void this.flush();
    };
    this.bridge.onrequestdisplaymode = async ({ mode }) => {
      const applied = this.cb.onDisplayModeRequest(mode);
      note("view requests display mode", `${mode} -> ${applied}`);
      return { mode: applied };
    };
    this.bridge.onsizechange = ({ width, height }) => note("view size", `${width ?? "?"} x ${height ?? "?"}`);
    this.bridge.onopenlink = async ({ url }) => {
      const opened = this.cb.onOpenLink(url);
      note("view opens link", url, opened ? "ok" : "error");
      return opened ? {} : { isError: true };
    };
    this.bridge.onmessage = async ({ content }) => {
      const text = content.map((c) => (c.type === "text" ? c.text : "")).join(" ").trim();
      note("view sends message", text);
      if (text) this.cb.onUserMessage(text);
      return {};
    };
    this.bridge.onloggingmessage = ({ level, data }) => note(`view log ${level}`, typeof data === "string" ? data : JSON.stringify(data));
  }

  /** Connect the bridge first, then load the document. */
  async start(html: string): Promise<void> {
    this.slot.append(this.iframe);
    const win = this.iframe.contentWindow;
    if (!win) throw new Error("The view iframe has no window.");
    await this.bridge.connect(new PostMessageTransport(win, win));
    this.iframe.srcdoc = html;
  }

  /** Same view, new data: no remount. Held until the view has initialized if it has not yet. */
  push(args: Record<string, unknown>, result: CallToolResult): void {
    this.latest = { args, result };
    if (this.ready) void this.flush();
  }

  setContext(ctx: HostContext): void {
    if (this.ready) this.bridge.setHostContext(ctx);
  }

  private async flush(): Promise<void> {
    const { args, result } = this.latest;
    try {
      await this.bridge.sendToolInput({ arguments: args });
      await this.bridge.sendToolResult(result);
    } catch (e) {
      eventLog.add({ source: "view", label: "view push failed", status: "error", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ready) await Promise.race([this.bridge.teardownResource({}).catch(() => undefined), sleep(600)]);
    await this.bridge.close().catch(() => undefined);
    this.iframe.remove();
  }
}
