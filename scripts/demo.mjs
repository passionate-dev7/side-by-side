// One command for the recorded demo: starts the fixture server and the Echo Show client, waits until both answer,
// prints the URL that runs the scripted journey, and stops both on Ctrl-C. No credentials are needed.
//   npm run demo            prints http://127.0.0.1:5173/?autorun=1
//   npm run demo -- --open  also opens it in the deepsurge browser profile through bhn
import { spawn, spawnSync } from "node:child_process";

const SERVER = "http://127.0.0.1:8790/health";
const CLIENT = "http://127.0.0.1:5173/";
const URL_RUN = `${CLIENT}?autorun=1`;
const kids = [];

const up = async (url) => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};

async function waitFor(url, what, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await up(url)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${what} did not answer at ${url} within ${ms / 1000}s`);
}

function start(label, args) {
  const p = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.env.DEMO_VERBOSE && process.stdout.write(`[${label}] ${d}`));
  p.stderr.on("data", (d) => process.env.DEMO_VERBOSE && process.stderr.write(`[${label}] ${d}`));
  p.on("exit", (code) => code && console.error(`${label} exited with ${code}`));
  kids.push(p);
}

const stop = () => {
  for (const k of kids) k.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (!(await up(SERVER))) start("server", ["run", "fixture", "-w", "server"]);
if (!(await up(CLIENT))) start("client", ["run", "dev", "-w", "sim"]);
await waitFor(SERVER, "the fixture server");
await waitFor(CLIENT, "the Echo Show client");

console.log(`Ready. Open ${URL_RUN}`);
console.log("The run takes about 80 seconds: family, search, seats, a flight with no adjacent seats, booking, the airline seating the family, then moving a child, and the later checks.");
if (process.argv.includes("--open")) {
  const r = spawnSync("bhn", ["deepsurge", "open", URL_RUN], { stdio: "ignore" });
  if (r.error || r.status !== 0) console.log("bhn is not available here; open the URL above in a browser.");
}
console.log("Ctrl-C stops both servers.");
setInterval(() => {}, 1 << 30);
