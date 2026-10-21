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

function mount(el: HTMLElement, quiet = false): void {
  if (quiet) el.classList.remove("is-in");
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

function draw(res: CallToolResult, quiet = false): void {
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
  const m = (el: HTMLElement) => mount(el, quiet);
  if (kind === "family") m(familyScreen(sc as FamilyView));
  else if (kind === "offers") m(offersScreen(sc as OffersView, ctx));
  else if (kind === "booked") m(bookedScreen(sc as BookedView));
  else if (kind === "together-status") m(statusScreen(sc as StatusView));
  else if (kind === "error") mount(errorScreen(sc as ErrorView));
  else if (res.isError) mount(errorScreen({ code: "tool_error", message: textOf(res) || "The request did not go through." }));
  else mount(waitingScreen(textOf(res) || null, null));
}

/**
 * Work that outlives a tool call (reading seat maps, placing an order, re-reading a booking) is answered with a state that
 * says so. The view then asks the same tool again, with the same arguments, until the state is final.
 */
function pendingCall(res: CallToolResult): { name: string; args: Record<string, unknown> } | null {
  const sc = res.structuredContent as Record<string, unknown> | undefined;
  if (!sc) return null;
  if (sc.kind === "offers" && sc.status === "searching") return { name: "find_family_flights", args: sc.query as Record<string, unknown> };
  if (sc.kind === "booked" && sc.status === "booking") return { name: "book_together", args: { offer_id: sc.offerId } };
  if (sc.kind === "together-status" && sc.refreshing === true) return { name: "still_together", args: { order_id: sc.orderId } };
  return null;
}

const POLL_MS = 700;
const POLL_LIMIT = 120;
let pollTimer: number | undefined;
let pollGen = 0;

function schedulePoll(res: CallToolResult, tries = 0): void {
  window.clearTimeout(pollTimer);
  const gen = ++pollGen;
  const next = pendingCall(res);
  if (!next || tries >= POLL_LIMIT) return;
  pollTimer = window.setTimeout(async () => {
    try {
      const r = await app.callServerTool({ name: next.name, arguments: next.args });
      if (gen !== pollGen) return;
      if (r.isError || kindOf(r) === "error") {
        mount(errorScreen({ code: "tool_error", message: errorText(r) }));
        return;
      }
      present(r, true, tries + 1);
    } catch (e) {
      if (gen === pollGen) toast(e instanceof Error ? e.message : String(e));
    }
  }, POLL_MS);
}

function present(res: CallToolResult, quiet = false, tries = 0): void {
  try {
    draw(res, quiet);
    schedulePoll(res, tries);
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
