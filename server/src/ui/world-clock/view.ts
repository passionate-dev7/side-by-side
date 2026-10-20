import { App } from "@modelcontextprotocol/ext-apps";

interface Reading {
  timezone: string;
  iso: string;
  localDate: string;
  utcOffset: string;
}

const $ = (id: string) => document.getElementById(id)!;
let timer: number | undefined;

function show(r: Reading) {
  const base = new Date(r.iso).getTime();
  const started = Date.now();
  const parts = (t: number) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: r.timezone, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
        .formatToParts(t)
        .map((p) => [p.type, p.value]),
    );
  $("place").textContent = r.timezone.split("/").pop()!.replace(/_/g, " ");
  $("zone").textContent = r.timezone;
  $("date").textContent = r.localDate;
  $("offset").textContent = r.utcOffset;
  $("face").innerHTML = '<span id="time"></span><span id="sec"></span><span id="meridiem"></span>';
  const tick = () => {
    const p = parts(base + (Date.now() - started));
    $("time").textContent = `${p.hour}:${p.minute}`;
    $("sec").textContent = p.second;
    $("meridiem").textContent = p.dayPeriod;
  };
  tick();
  clearInterval(timer);
  timer = window.setInterval(tick, 1000);
}

const app = new App({ name: "world-clock-view", version: "0.1.0" });
app.ontoolresult = (res) => {
  const sc = res.structuredContent as Reading | { error: string } | undefined;
  if (sc && "iso" in sc) show(sc);
  else {
    const err = document.createElement("span");
    err.id = "err";
    err.textContent = (res.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(" ") || "No time available";
    $("face").replaceChildren(err);
  }
};
app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
};
app.connect().then(() => {
  const theme = app.getHostContext()?.theme;
  if (theme) document.documentElement.dataset.theme = theme;
});
