import type { Cell, SeatMapView, Traveler } from "../../domain.js";
import { h, reducedMotion } from "./dom.js";
import { money, seatLetter } from "./format.js";
import { chip, head, screen, testTag, type Ctx } from "./screens.js";

type SeatCell = Extract<Cell, { kind: "seat" }>;

/**
 * The seat-map screen. One instance lives while the same offer stays open: a later tool result for the
 * same offer calls update() so chips animate to their new seats instead of the screen remounting.
 */
export class SeatMapScreen {
  readonly el: HTMLElement;
  private view: SeatMapView;
  private selected: string | null = null;
  private busy = false;
  private suppressClick = false;
  private cabinEl: HTMLElement | null = null;
  private stopDrag: (() => void) | null = null;

  constructor(view: SeatMapView, private readonly ctx: Ctx) {
    this.view = view;
    this.el = screen("seat-map");
    this.paint();
  }

  get offerId(): string {
    return this.view.offerId;
  }

  update(view: SeatMapView): void {
    const before = this.chipRects();
    this.view = view;
    if (this.selected && !view.travelers.some((t) => t.id === this.selected)) this.selected = null;
    this.paint();
    this.flip(before);
  }

  private traveler(id: string): Traveler | undefined {
    return this.view.travelers.find((t) => t.id === id);
  }

  private findSeat(designator: string): SeatCell | undefined {
    for (const row of this.view.rows) for (const c of row.cells) if (c.kind === "seat" && c.designator === designator) return c;
    return undefined;
  }

  private paint(): void {
    this.stopDrag?.();
    const v = this.view;
    const sub = [v.airline.name, v.route.flightNumber].filter(Boolean).join(" ");
    const flagged = new Set(v.violations.map((x) => x.travelerId));
    this.cabinEl = h(
      "section",
      { class: "cabin", "aria-label": "Seat map", "aria-busy": this.busy ? "true" : null },
      ...v.rows.flatMap((r, i) => {
        const prev = v.rows[i - 1];
        const skipped = prev && r.row - prev.row > 1 ? [this.skip(prev.row + 1, r.row - 1)] : [];
        return [...skipped, this.row(r.row, r.cells, flagged)];
      }),
    );
    if (this.selected) this.cabinEl.setAttribute("data-armed", "");
    const body = v.rows.length
      ? h("div", { class: "map" }, this.cabinEl, this.panel())
      : h("div", { class: "map" }, h("p", { class: "nomap" }, "No seat map came back for this flight."), this.panel());
    this.el.replaceChildren(
      head(`${v.route.origin} to ${v.route.destination}`, [h("span", { class: "sub" }, sub), v.testMode ? testTag() : null]),
      body,
      this.foot(),
    );
  }

  /** Rows between two shown windows are not displayed: say so, so the gap is never read as adjacency. */
  private skip(from: number, to: number): HTMLElement {
    const label = from === to ? `row ${from}` : `rows ${from} to ${to}`;
    return h("div", { class: "skip", role: "separator", "aria-label": `${label} not shown` }, h("span", {}, label));
  }

  private row(rowNo: number, cells: Cell[], flagged: Set<string>): HTMLElement {
    const cols = cells.map((c) => (c.kind === "aisle" ? "16px" : "minmax(0, 1fr)")).join(" ");
    return h("div", { class: "row", style: `--cols: ${cols}` }, h("span", { class: "rownum" }, String(rowNo)), ...cells.map((c) => this.cell(c, flagged)));
  }

  private cell(c: Cell, flagged: Set<string>): HTMLElement {
    if (c.kind === "aisle") return h("span", { class: "aisle", "aria-hidden": "true" });
    if (c.kind === "blank") return h("span", { class: "blank", "aria-hidden": "true" });
    const t = c.travelerId ? this.traveler(c.travelerId) : undefined;
    if (t) {
      const len = t.name.length;
      const chipEl = h(
        "button",
        {
          class: `trav ${t.role === "child" ? "is-child" : "is-adult"}${len >= 7 ? " is-xlong" : len >= 4 ? " is-long" : ""}${flagged.has(t.id) ? " is-flagged" : ""}`,
          type: "button",
          "data-traveler": t.id,
          "aria-pressed": this.selected === t.id ? "true" : "false",
          "aria-label": `${t.name}, ${t.role}, seat ${c.designator}${flagged.has(t.id) ? ", needs an adult beside them" : ""}. Select to move.`,
        },
        h("span", { class: "nm" }, t.name),
      );
      chipEl.addEventListener("click", () => this.onChipClick(t.id));
      chipEl.addEventListener("pointerdown", (e) => this.onChipDown(e, chipEl, t.id));
      return h("div", { class: "seat is-mine", "data-seat": c.designator }, chipEl);
    }
    if (c.state === "taken") return h("div", { class: "seat is-taken", "aria-label": `Seat ${c.designator}, taken` }, h("span", {}, seatLetter(c.designator)));
    const free = h(
      "button",
      { class: "seat is-free", type: "button", "data-seat": c.designator, "aria-label": `Seat ${c.designator}, free${c.fee ? `, ${money(c.fee, this.view.currency)}` : ""}` },
      seatLetter(c.designator),
      c.fee ? h("span", { class: "fee" }, money(c.fee, this.view.currency)) : null,
    );
    free.addEventListener("click", () => {
      if (this.selected) void this.move(this.selected, c.designator);
    });
    return free;
  }

  private panel(): HTMLElement {
    const v = this.view;
    const sel = this.selected ? this.traveler(this.selected) : undefined;
    const reasons = [...new Set(v.violations.map((x) => x.reason))];
    return h(
      "aside",
      { class: "panel" },
      h(
        "div",
        { class: "verdict", role: "status" },
        v.together === "TOGETHER" ? chip("ok", "Sitting together", true) : chip("warn", "Not together", true),
        ...(reasons.length ? reasons.slice(0, 2).map((r) => h("p", { class: "reason" }, r)) : v.together === "TOGETHER" ? [h("p", { class: "reason" }, "Every child has an adult beside them.")] : []),
        v.guarantee && v.seatFees === 0 ? chip("accent", "$0 seat fee") : null,
      ),
      sel ? h("p", { class: "hint live" }, `Tap a seat for ${sel.name}.`) : h("p", { class: "hint" }, "Drag a name to a seat, or tap a name, then a seat."),
      h("div", { class: "legend" }, ...(["adult", "child", "taken"] as const).map((k) => h("span", {}, h("b", { class: `k-${k}`, "aria-hidden": "true" }), k === "adult" ? "Adult" : k === "child" ? "Child" : "Taken"))),
    );
  }

  private foot(): HTMLElement {
    const v = this.view;
    const part = (n: string, l: string, sum = false) => h("div", { class: sum ? "pp sum" : "pp" }, h("span", { class: "n" }, n), h("span", { class: "l" }, l));
    const book = h("button", { class: "btn", type: "button" }, "Book it");
    book.addEventListener("click", async () => {
      if (book.getAttribute("aria-busy") === "true") return;
      book.setAttribute("aria-busy", "true");
      book.textContent = "Booking";
      const ok = await this.ctx.run("book_together", { offer_id: v.offerId });
      if (!ok) {
        book.removeAttribute("aria-busy");
        book.textContent = "Book it";
      }
    });
    return h(
      "footer",
      { class: "foot" },
      h(
        "div",
        { class: "price", "aria-label": "Fare plus seats equals together total" },
        part(money(v.fare, v.currency), "Fare"),
        h("span", { class: "op", "aria-hidden": "true" }, "+"),
        part(money(v.seatFees, v.currency), "Seats"),
        h("span", { class: "op", "aria-hidden": "true" }, "="),
        part(v.togetherTotal === null ? "Not priced" : money(v.togetherTotal, v.currency), "Together total", true),
      ),
      book,
    );
  }

  private onChipClick(id: string): void {
    if (this.suppressClick) return;
    this.selected = this.selected === id ? null : id;
    this.paint();
    this.el.querySelector<HTMLElement>(`[data-traveler="${CSS.escape(id)}"]`)?.focus();
  }

  private onChipDown(e: PointerEvent, chipEl: HTMLElement, travelerId: string): void {
    if (e.button !== 0 || this.busy) return;
    this.suppressClick = false;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let ghost: HTMLElement | null = null;
    let target: HTMLElement | null = null;
    chipEl.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
        ghost = chipEl.cloneNode(true) as HTMLElement;
        ghost.removeAttribute("aria-pressed");
        ghost.classList.add("ghost");
        document.body.append(ghost);
        chipEl.classList.add("is-dragging");
        this.suppressClick = true;
      }
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".seat.is-free") ?? null;
      if (over !== target) {
        target?.classList.remove("is-target");
        target = over;
        target?.classList.add("is-target");
      }
    };
    const finish = (drop: boolean) => {
      const seat = drop ? target?.dataset.seat : undefined;
      cleanup();
      if (seat) void this.move(travelerId, seat);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const cleanup = () => {
      chipEl.removeEventListener("pointermove", onMove);
      chipEl.removeEventListener("pointerup", onUp);
      chipEl.removeEventListener("pointercancel", onCancel);
      ghost?.remove();
      target?.classList.remove("is-target");
      chipEl.classList.remove("is-dragging");
      this.stopDrag = null;
      setTimeout(() => (this.suppressClick = false), 0);
    };
    this.stopDrag = cleanup;
    chipEl.addEventListener("pointermove", onMove);
    chipEl.addEventListener("pointerup", onUp);
    chipEl.addEventListener("pointercancel", onCancel);
  }

  private async move(travelerId: string, seat: string): Promise<void> {
    const t = this.traveler(travelerId);
    const target = this.findSeat(seat);
    if (this.busy || !t || !target || target.state !== "free" || target.travelerId) return;
    const previous = this.selected;
    this.selected = null;
    this.busy = true;
    this.cabinEl?.setAttribute("aria-busy", "true");
    const ok = await this.ctx.run("move_traveler", { offer_id: this.view.offerId, traveler: t.name, seat });
    this.busy = false;
    this.cabinEl?.removeAttribute("aria-busy");
    if (!ok) {
      this.selected = previous;
      this.paint();
    }
  }

  private chipRects(): Map<string, DOMRect> {
    const m = new Map<string, DOMRect>();
    this.el.querySelectorAll<HTMLElement>(".trav[data-traveler]").forEach((c) => m.set(c.dataset.traveler as string, c.getBoundingClientRect()));
    return m;
  }

  private flip(before: Map<string, DOMRect>): void {
    if (reducedMotion()) return;
    this.el.querySelectorAll<HTMLElement>(".trav[data-traveler]").forEach((c) => {
      const prev = before.get(c.dataset.traveler as string);
      if (!prev) return;
      const now = c.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (!dx && !dy) return;
      c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 120, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    });
  }
}
