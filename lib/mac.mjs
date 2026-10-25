// mac: macOS apps through the Accessibility API, via a small Swift driver
// (lib/ax.swift, built on first use). `flow` is the driver for the Jev decision loop
// (lib/jev.mjs); dump, click, type, key, menu, apps and open are the manual commands.
// Actions are AX presses, value sets and app-targeted key events, so the pointer,
// keyboard focus and front app never move.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, run, startKey } from "./jev.mjs";
import { parsePlan, runPlan } from "./plan.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "ax.swift");
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "mac");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// driver builds ax.swift once per source version; a stale binary is never used.
function driver() {
  const hash = createHash("sha256").update(readFileSync(SRC)).digest("hex").slice(0, 12);
  const bin = join(CACHE, `mac-ax-${hash}`);
  if (existsSync(bin)) return bin;
  mkdirSync(CACHE, { recursive: true });
  const r = spawnSync("swiftc", ["-O", SRC, "-o", bin + ".tmp"], { encoding: "utf8" });
  if (r.error || r.status !== 0)
    throw new Error(`building the driver needs Swift (xcode-select --install): ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
  renameSync(bin + ".tmp", bin);
  return bin;
}

// ax runs one driver call; text goes on stdin, never on a command line.
function ax(args, input = "") {
  const r = spawnSync(driver(), args, { input, encoding: "utf8", timeout: 20000 });
  const out = (r.stdout || "").trim();
  if (r.error) throw new Error(`driver: ${r.error.message}`);
  if (r.status !== 0) throw new Error(out || (r.stderr || "").trim() || `driver exited ${r.status}`);
  return out;
}

// the last dump per app, so a later "@N" is checked against what it named then
const lastFile = (app) => join(CACHE, `last-${createHash("sha256").update(app).digest("hex").slice(0, 12)}.json`);
function was(app, spec) {
  const n = spec.match(/^@(\d+)$/)?.[1];
  if (!n) return [];
  let items = [];
  try { items = JSON.parse(readFileSync(lastFile(app), "utf8")); } catch {}
  const it = items[+n - 1];
  if (!it) throw new Error(`no ${spec} in the last dump; run mac dump`);
  return ["--was", it.label, it.role];
}

const dump = (app) => JSON.parse(ax(["dump", app]));

const USAGE = `usage: mac <command> --app NAME ...  (mac setup checks the install)
  flow "GOAL"            a routine flow; Jev picks each step  [--value NAME=TEXT] [--secret NAME=ENVVAR] [--steps N] [--dry-run] [--allow-risky]
  plan FILE --app NAME   a JSON plan of deterministic steps, each with an observable
                         postcondition; on a mismatch one bounded recovery replans the
                         goal through flow, and the goal is accepted only on the plan's
                         own assertions — never on a click's exit or a DONE  [--dry-run]
                         steps are click/type only; a risky resolved control stops it
  dump                   controls as @N refs, then the window's text
  click <@N|label>       press a control, or select a row (Chromium/Electron: a background click)
  click --at X,Y         click a window-local point (canvases such as charts and maps)
                         --right / --double on any click
  drag --at X,Y --to X,Y drag between window-local points
  scroll <up|down|left|right> [@N|label]   scroll the control, --at X,Y, or the window centre  [--lines N]
  shot FILE.png          screenshot the window, even covered or on another Desktop (needs Screen Recording)
  type <@N|label> TEXT   set a field (--secret ENVVAR reads it from the environment; --keys types real keystrokes)
  key <combo>            e.g. return, escape, tab, cmd+a, cmd+shift+n
  menu "File > New"      choose a menu-bar item
  open                   launch the app in the background
  apps                   apps with a window (find a dialog's owner, e.g. SecurityAgent)

mac setup            build the driver and get the Accessibility permission`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (i + 1 >= args.length) throw new Error(`${name} needs a value`);
  return args.splice(i, 2)[1];
}

// ensureRunning launches the app in the background; the driver hands the front straight back
// if the app takes it when its first window opens.
async function ensureRunning(app) {
  if (ax(["running", app]) === "up") return;
  if (ax(["launch", app]) !== "up") throw new Error(`${app} did not start`);
}

async function manual(cmd, args) {
  if (cmd === "apps") return console.log(ax(["apps"]));
  const app = flag(args, "--app");
  if (!app) throw new Error("--app NAME is required (exact app name or bundle id; `mac apps` lists them)");
  if (cmd === "open") return ensureRunning(app).then(() => console.log(`${app} running`));
  if (cmd === "dump") {
    const d = dump(app);
    writeFileSync(lastFile(app), JSON.stringify(d.items));
    console.log(`${d.app} — "${d.window}"` + (d.locked ? " (screen locked: reads work, mouse input and shot do not)" : ""));
    for (const it of d.items)
      console.log(`@${it.ref} [${it.role}] "${it.label}"` + (it.value ? ` = "${it.value}"` : "") + (it.state ? ` (${it.state})` : "") + (it.selected ? " (selected)" : ""));
    if (d.context.length) console.log("text: " + d.context.join(" | "));
    return;
  }
  if (cmd === "shot" && args[0]) return console.log(ax(["shot", app, args[0]]));
  const at = flag(args, "--at"), to = flag(args, "--to"), lines = flag(args, "--lines");
  const how = ["--right", "--double"].filter((f) => args.includes(f) && args.splice(args.indexOf(f), 1));
  const where = [...(at ? ["--at", at] : []), ...(to ? ["--to", to] : []), ...(lines ? ["--lines", lines] : [])];
  if (cmd === "click" && at) return console.log(ax(["click", app, ...where, ...how]));
  if (cmd === "drag") return console.log(ax(["drag", app, ...where]));
  if (cmd === "scroll" && args[0]) return console.log(ax(["scroll", app, ...args.slice(0, 2), ...where, ...(args[1] ? was(app, args[1]) : [])]));
  const secret = flag(args, "--secret");
  const keys = args.includes("--keys") && args.splice(args.indexOf("--keys"), 1).length > 0;
  const [target, ...rest] = args;
  if (cmd === "click" && target) return console.log(ax(["click", app, target, ...was(app, target), ...how]));
  if (cmd === "key" && target) return console.log(ax(["key", app, target]));
  if (cmd === "menu" && target) return console.log(ax(["menu", app, target]));
  if (cmd === "type" && target) {
    const text = secret ? process.env[secret] : rest.join(" ");
    if (!text) throw new Error(secret ? `--secret ${secret}: $${secret} is empty` : "type needs TEXT or --secret ENVVAR");
    return console.log(ax(["type", app, target, ...was(app, target), ...(keys ? ["--keys"] : [])], text));
  }
  throw new Error(USAGE);
}

async function flow(args) {
  const argv = args.flatMap((a, i, all) => all[i - 1] === "--secret" // NAME=ENVVAR -> NAME=value
    ? [a.replace(/=(.*)$/, (_, v) => { if (!process.env[v]) throw new Error(`--secret ${a}: $${v} is empty`); return "=" + process.env[v]; })] : [a]);
  const o = parseArgs(argv, ["--app"], USAGE);
  if (!o.app) throw new Error("--app NAME is required (the terminal is usually the front app)");
  const key = startKey(); // overlaps the app launch and first Accessibility read
  await ensureRunning(o.app);
  const observe = observer(o.app);
  const act = async (op, target, text) => {
    // the driver re-reads the window and refuses if the ref no longer names this control
    ax(["act", o.app, target ? target.ref : "0", op, "--was", target ? target.label : "", target ? target.role : ""], text || "");
    return op === "TYPE_TEXT" ? `typed a value into "${target.label}"` : op === "CLICK" ? `clicked ${target.role} "${target.label}"` : "pressed Enter";
  };
  await run({ key, o, surface: `macOS app (${o.app})`, driver: { observe, act, scroll: false } });
}

// observe reads the app once, and re-reads (up to 4 × 250 ms) while the window
// is still the one from before — an action's effect is given a moment to settle.
function observer(app) {
  return async (before) => {
    let d = dump(app), sig = JSON.stringify([d.window, d.items, d.context]);
    for (let i = 0; before !== undefined && sig === before && i < 4; i++) { // re-read only while unchanged
      await sleep(250);
      d = dump(app);
      sig = JSON.stringify([d.window, d.items, d.context]);
    }
    return { items: d.items, context: d.context, where: { app: d.app, window: d.window }, sig };
  };
}

// plan runs a caller-supplied JSON plan (lib/plan.mjs): deterministic steps with
// observable postconditions, one bounded recovery through the flow loop above,
// and an independent final check against the plan's own success assertions.
async function planCmd(args) {
  const dryRun = args.includes("--dry-run") && args.splice(args.indexOf("--dry-run"), 1).length > 0;
  const app = flag(args, "--app");
  if (!app) throw new Error("--app NAME is required");
  // anything else is refused, --allow-risky included: a plan never presses a risky control
  if (args.length !== 1 || (args[0].startsWith("--") && args[0] !== "-")) throw new Error(`plan takes one JSON file (or - for stdin), --app and --dry-run; got ${JSON.stringify(args)}`);
  const file = args[0];
  const plan = parsePlan(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8"));
  const key = startKey();
  await ensureRunning(app);
  const observe = observer(app);
  const act = async (s, item) => {
    ax(["act", app, item.ref, s.op === "type" ? "TYPE_TEXT" : "CLICK", "--was", item.label, item.role], s.op === "type" ? s.text : "");
    return s.op === "type" ? `typed into "${item.label}"` : `clicked ${item.role} "${item.label}"`;
  };
  const flowTo = (goal) => run({ key, o: { goal, steps: 15, minConf: 0.6, values: [], dryRun: false, allowRisky: false },
    surface: `macOS app (${app})`,
    driver: { observe, act: async (op, target, text) => {
      ax(["act", app, target ? target.ref : "0", op, "--was", target ? target.label : "", target ? target.role : ""], text || "");
      return op === "TYPE_TEXT" ? `typed a value into "${target.label}"` : op === "CLICK" ? `clicked ${target.role} "${target.label}"` : "pressed Enter";
    }, scroll: false } });
  const result = await runPlan(plan, { observe, act, flow: flowTo }, { dryRun });
  const ok = result.ok || (dryRun && !result.stopped); // a dry run that hits a safety stop fails
  console.log(`${ok ? "plan done" : "plan failed"}: ${JSON.stringify(result)}`);
  process.exitCode = ok ? 0 : 1;
}

// setup builds the driver and gets the one permission macOS requires: it asks for
// Accessibility, opens that settings page and waits for the switch.
async function setup() {
  const rows = [];
  rows.push(["node", `node ${process.version}`]);
  let built = true;
  try { driver(); rows.push(["driver (Swift)", "built"]); }
  catch (e) { built = false; rows.push(["driver (Swift)", e.message]); }
  if (built) {
    let state = ax(["trusted", "--prompt"]);
    if (state !== "granted") {
      console.log("Turn on the app you run mac from (your terminal or agent app) in the page that opened.");
      execFileSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);
      for (let i = 0; i < 120 && state !== "granted"; i++) { await sleep(1000); state = ax(["trusted"]); }
    }
    rows.push(["Accessibility permission", state === "granted" ? "granted" : "not granted: System Settings > Privacy & Security > Accessibility"]);
  }
  const decider = process.env.TYPESAFE_API_KEY ? "TYPESAFE_API_KEY set (Jev)"
    : process.env.DECISION_URL ? `DECISION_URL set (${process.env.DECISION_MODEL || "no DECISION_MODEL!"})`
    : "not set: flow needs TYPESAFE_API_KEY (Jev), or DECISION_URL+DECISION_MODEL for an OpenAI-compatible model";
  rows.push(["decision model", decider]);
  for (const [k, v] of rows) console.log(`${k.padEnd(24)} ${v}`);
  if (rows.some(([, v]) => /needs Swift|not granted/.test(v))) process.exitCode = 1;
}

const [cmd, ...args] = process.argv.slice(2);
try { await (cmd === "flow" ? flow(args) : cmd === "plan" ? planCmd(args) : cmd === "setup" ? setup(args) : cmd ? manual(cmd, args) : Promise.reject(new Error(USAGE))); }
catch (e) { console.log(`mac ${cmd || ""}: ${e.message}`); process.exitCode = 1; }
