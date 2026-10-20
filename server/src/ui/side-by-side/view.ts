import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BookedView, ErrorView, FamilyView, OffersView, SeatMapView, StatusView } from "../../domain.js";
import { h } from "./dom.js";
import { SeatMapScreen } from "./seat-map.js";
import { bookedScreen, errorScreen, familyScreen, offersScreen, statusScreen, waitingScreen, type Ctx } from "./screens.js";

const root = document.getElementById("root") as HTMLElement;
const stage = h("div", { id: "stage" });
const toastEl = h("div", { class: "toast", role: "alert", "data-gone": "" });
root.append(stage, toastEl);

let seatScreen: SeatMapScreen | null = null;
let toastTimer: number | undefined;

const app = new App({ name: "side-by-side-view", version: "0.1.0" });

function textOf(res: CallToolResult): string {
  return (res.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(" ").trim();
}

function kindOf(res: CallToolResult): string | null {
  const sc = res.structuredContent as { kind?: unknown } | undefined;
  return sc && typeof sc.kind === "string" ? sc.kind : null;
}

function errorText(res: CallToolResult): string {
  const sc = res.structuredContent as Partial<ErrorView> | undefined;
  return (sc?.kind === "error" && sc.message) || textOf(res) || "The request did not go through.";
}

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.removeAttribute("data-gone");
  toastEl.style.animation = "none";
  void toastEl.offsetWidth;
  toastEl.style.animation = "";
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.setAttribute("data-gone", ""), 7000);
}

function mount(el: HTMLElement): void {
  stage.replaceChildren(el);
  toastEl.setAttribute("data-gone", "");
}

const ctx: Ctx = {
  toast,
  async run(name, args) {
    try {
      const res = await app.callServerTool({ name, arguments: args });
      if (res.isError || kindOf(res) === "error") {
        toast(errorText(res));
        return false;
      }
      present(res);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return false;
    }
  },
};

function draw(res: CallToolResult): void {
  const sc = res.structuredContent as unknown;
  const kind = kindOf(res);
  if (kind === "seat-map") {
    const v = sc as SeatMapView;
    if (seatScreen && seatScreen.offerId === v.offerId && seatScreen.el.isConnected) seatScreen.update(v);
    else {
      seatScreen = new SeatMapScreen(v, ctx);
      mount(seatScreen.el);
    }
    return;
  }
  seatScreen = null;
  if (kind === "family") mount(familyScreen(sc as FamilyView));
  else if (kind === "offers") mount(offersScreen(sc as OffersView, ctx));
  else if (kind === "booked") mount(bookedScreen(sc as BookedView));
  else if (kind === "together-status") mount(statusScreen(sc as StatusView));
  else if (kind === "error") mount(errorScreen(sc as ErrorView));
  else if (res.isError) mount(errorScreen({ code: "tool_error", message: textOf(res) || "The request did not go through." }));
  else mount(waitingScreen(textOf(res) || null, null));
}

function present(res: CallToolResult): void {
  try {
    draw(res);
  } catch (e) {
    seatScreen = null;
    mount(errorScreen({ code: "render_failed", message: `This screen could not be drawn. ${e instanceof Error ? e.message : String(e)}` }));
  }
}

function applyTheme(theme: string | undefined): void {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
}

mount(waitingScreen(null, null));

app.ontoolinput = (p) => {
  const a = p.arguments as Record<string, unknown> | undefined;
  const route = a && typeof a.origin === "string" && typeof a.destination === "string" ? `${a.origin} to ${a.destination}` : null;
  if (stage.firstElementChild?.getAttribute("data-kind") === "waiting") mount(waitingScreen(null, route));
};
app.ontoolresult = present;
app.onhostcontextchanged = (c) => applyTheme(c.theme);
app.onteardown = async () => ({});

app.connect().then(
  () => applyTheme(app.getHostContext()?.theme),
  (e: unknown) => mount(errorScreen({ code: "host_unavailable", message: `The host did not answer. ${e instanceof Error ? e.message : String(e)}` })),
);
