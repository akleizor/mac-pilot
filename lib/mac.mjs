// mac: macOS apps through the Accessibility API, via a small Swift driver
// (lib/ax.swift, built on first use). `flow` is the driver for the Jev decision loop
// (lib/jev.mjs); dump, click, type, key, menu, apps and open are the manual commands.
// Actions are AX presses, value sets and app-targeted key events, so the pointer,
// keyboard focus and front app never move.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, run, startKey } from "./jev.mjs";
import { parsePlan, runPlan } from "./plan.mjs";
import { READ, act as webScript, find as webFind, search as webSearch } from "./web.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "ax.swift");
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "mac");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // a blocking sleep

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
  if (args[1]) aimAtOwn(args[1]);
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
                         --right / --double / --mods cmd+shift on any click
  drag --at X,Y --to X,Y drag between window-local points  [--mods shift]
  scroll <up|down|left|right> [@N|label]   scroll the control, --at X,Y, or the window centre  [--lines N]
  shot FILE.png          screenshot the window, even covered or on another Desktop (needs Screen Recording)
  record FILE.mov        video of the window, even covered, in the background  [--seconds N, default 30]
  type <@N|label> TEXT   set a field (--secret ENVVAR reads it from the environment; --keys types real keystrokes)
  key <combo>            e.g. return, escape, tab, cmd+a, cmd+shift+n
  menu "File > New"      choose a menu-bar item
  open                   launch the app in the background
  apps                   apps with a window (find a dialog's owner, e.g. SecurityAgent)

browsers (Chrome, Edge, Brave, Safari; JavaScript as an argument or on stdin, the result printed):
  js [--url PART]        run JavaScript in the front tab, or the first tab whose URL contains PART;
                         the user's own signed-in profile, any tab, in the background
  tab URL                open URL in the agent's own window (made once, behind the user's; later
                         calls change its page, so nothing on screen moves);
                         every command then aims there, the user's windows untouched
  tabs                   every tab's title and URL (* the agent's window)

mac setup            build the driver and get the Accessibility permission`;

// js runs JavaScript in a browser tab through AppleScript: no extension, no CDP and no window
// focus. Chromium browsers (Chrome, Edge, Brave) and Safari; Firefox has no such scripting.
// The agent works in its own window of the user's browser (same profile and sign-ins), made by
// `tab`: commands aim there unless --url picks a tab, so the user's own windows stay untouched.
const JXA = `ObjC.import("Foundation"); ObjC.import("AppKit");
function run(argv) {
  const [app, mode, url, mine] = argv, b = Application(app), safari = b.id() === "com.apple.Safari";
  const wins = b.windows(), own = wins.find((w) => String(w.id()) === mine);
  const tabs = wins.flatMap((w) => (w.tabs() || []).map((t) => [w, t])); // Safari lists tabless windows (closing, settings)
  const title = (t) => safari ? t.name() : t.title();
  const active = (w) => safari ? w.currentTab : w.activeTab;
  if (mode === "tabs") return tabs.map(([w, t], i) => (i + 1) + (w === own ? " *" : "  ") + " " + title(t) + "  " + t.url()).join("\\n");
  if (mode === "bounds") { if (!own) return ""; const r = own.bounds(); return [r.x, r.y, r.width, r.height].join(","); }
  if (mode === "home") { // fully on the primary screen, still behind: captures show the whole page
    const f = $.NSScreen.screens.objectAtIndex(0).visibleFrame, h = $.NSScreen.screens.objectAtIndex(0).frame.size.height, r = own.bounds();
    own.bounds = { x: f.origin.x, y: h - f.origin.y - f.size.height, width: r.width, height: r.height };
    return "";
  }
  if (mode === "open") {
    const had = new Set(wins.map((w) => w.id())); // the browser may open its own start window too
    if (safari) b.Document({ url }).make(); else b.Window().make();
    const w = b.windows().find((x) => !had.has(x.id())) || b.windows[0], main = $.NSScreen.screens.objectAtIndex(0), f = main.visibleFrame, h = main.frame.size.height; // the primary screen, as uncovered() in ax.swift
    // parked in the bottom-right corner, all but 80x80 of it off screen: the moment the browser
    // brings it forward shows only there, and the corner on screen lets it be pinned awake
    const r = w.bounds();
    w.bounds = { x: f.origin.x + f.size.width - 80, y: h - f.origin.y - 80, width: Math.max(r.width, 1280), height: Math.max(r.height, 900) };
    if (!safari) w.activeTab.url = url;
    return String(w.id());
  }
  const code = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js;
  const hit = url && tabs.find(([, t]) => (t.url() || "").includes(url));
  if (url && !hit) throw new Error("no tab whose URL contains " + url);
  const tab = hit ? hit[1] : active(own || b.windows[0]);
  const r = safari ? b.doJavaScript(code, { in: tab }) : b.execute(tab, { javascript: code });
  return r === undefined || r === null ? "" : String(r);
}`;
const ownFile = (app) => join(CACHE, `own-${createHash("sha256").update(app).digest("hex").slice(0, 12)}`);
const ownId = (app) => { try { return readFileSync(ownFile(app), "utf8").trim(); } catch { return ""; } };
function osa(app, mode, url, code = "", via = []) {
  const r = spawnSync(via.length ? via[0] : "osascript", [...via.slice(1), ...(via.length ? ["/usr/bin/osascript"] : []), "-l", "JavaScript", "-e", JXA, app, mode, url || "", ownId(app)],
    { input: code, encoding: "utf8", timeout: 30000 });
  const err = (r.stderr || "").trim();
  if (/turned off|applescript-javascript|Allow JavaScript from Apple Events/i.test(err))
    throw new Error(`${app} blocks JavaScript from AppleScript, so use dump, click and type. It is faster with ` +
      (/safari/i.test(app) ? "Safari > Settings > Advanced > Show features for web developers, then Develop > Allow JavaScript from Apple Events"
        : /dia/i.test(app) ? "Dia started with --enable-applescript-javascript"
        : "View > Developer > Allow JavaScript from Apple Events") + " turned on");
  if (/-1743|not allowed to send Apple events/i.test(err))
    throw new Error(`macOS has not let this terminal control ${app}: allow it in System Settings > Privacy & Security > Automation`);
  if (/-1719|-1728/.test(err)) throw new Error(`${app} has no window open`);
  if (r.status !== 0) throw new Error(err.replace(/^.*execution error: /, "") || `osascript exited ${r.status}`);
  return r.stdout.replace(/\n$/, "");
}
function js(app, url, list, code = "") {
  if (/firefox/i.test(app)) throw new Error("Firefox cannot run JavaScript from AppleScript; use dump, click and type");
  return osa(app, list ? "tabs" : "run", url, code);
}
// tab opens URL in the agent's own window, making that window the first time; the browser
// brings a new window or tab forward, so it runs behind the driver, which hands the front back
function tab(app, url) {
  // once the window exists, its tab changes page through JavaScript: nothing on screen moves.
  // Only the first call makes a window, which the browser brings forward for a moment.
  if (ownId(app) && osa(app, "bounds", "")) osa(app, "run", "", `${MARK} location.href = ${JSON.stringify(url)}; ""`);
  else {
    writeFileSync(ownFile(app), osa(app, "open", url, "", [driver(), "behind"]));
    // pin it awake while its corner shows, then move it whole onto the screen behind the user's
    // windows: macOS captures only the on-screen part of a window, so shot and record need it there
    process.env.MAC_WINDOW = osa(app, "bounds", "");
    try { ax(["awake", app]); } catch {}
    osa(app, "home", "");
    delete process.env.MAC_WINDOW;
  }
  settle(app, "", true);
}
// MARK tags the page before an action; settle then waits for whatever the action started: a
// new page (the tag is gone) until it has content, and either way until the page holds still.
// A page still "loading" over a slow network often has its controls already; lookups by
// label retry on their own (webTarget), so this only has to get past blank pages and shells.
const MARK = "window.__mp = 1; addEventListener('beforeunload', () => { window.__mp = 2; });";
function settle(app, url, nav = false) {
  const t0 = Date.now();
  let counts = [], ready = 0;
  while (Date.now() - t0 < 15000 && (!ready || Date.now() - ready < 3000)) {
    const r = js(app, url, false, "(window.__mp === 1 ? 'same' : window.__mp ? 'leaving' : location.href.startsWith('about:blank') ? 'blank' : document.readyState) + ' ' + document.querySelectorAll('*').length");
    const [state, n] = (r || "loading 0").split(" ");
    // a navigation starts a beat after the call: until then the old page answers "same"
    const settled = state === "complete" || (state === "same" && (!nav || Date.now() - t0 > 2000)) || (state !== "same" && state !== "leaving" && state !== "blank" && +n >= 100);
    if (settled) {
      ready ||= Date.now();
      counts = [...counts, +n].slice(-3); // lazy lists and carousels never stop, so "still" is within 1%
      if (counts.length === 3 && Math.max(...counts) - Math.min(...counts) <= Math.max(...counts) / 100) return;
    } else counts = [];
    pause(100);
  }
}
// in the agent's window, gestures, shot and record aim there too (MAC_WINDOW: its frame)
let ownBounds;
function aimAtOwn(app) {
  if (ownBounds !== undefined || !BROWSER.test(app) || !ownId(app)) return;
  try { ownBounds = osa(app, "bounds", ""); } catch { ownBounds = ""; }
  if (ownBounds) process.env.MAC_WINDOW = ownBounds;
}

const BROWSER = /chrome|chromium|edge|brave|safari|vivaldi|opera|arc|dia/i;
// webRead reads the tab through JavaScript, or returns null when the browser blocks that,
// so the Accessibility path serves instead: a browser with the setting off still works, slower.
let woke = false;
function webRead(app, url) {
  if (!BROWSER.test(app)) return null;
  if (!woke) { woke = true; try { ax(["awake", app]); } catch {} } // a covered Chromium window loads pages slowly
  try { // a tab between pages answers JavaScript with nothing: wait for the new page, up to 30 s
    for (let i = 0; i < 300; i++) { const r = js(app, url, false, READ); if (r) return JSON.parse(r); pause(100); }
    throw new Error("the page did not load in 30 s");
  }
  catch (e) { if (/blocks JavaScript|cannot run JavaScript/.test(e.message)) return null; throw e; }
}
function webDo(app, url, op, it, text = "") {
  const r = js(app, url, false, MARK + webScript(op, it?.ref, it?.label, text));
  if (r === "stale") throw new Error(`stale ref ${it.ref}: "${it.label}" is gone or changed; run mac dump`);
  if (op === "CLICK" || op === "PRESS_ENTER" || op === "TYPE_TEXT") settle(app, url);
  return r.replace(/, leaving .*$/, "");
}
const webLast = (app) => { try { const d = JSON.parse(readFileSync(lastFile(app), "utf8")); return d.web ? d.items : null; } catch { return null; } };
// webTarget resolves @N against the last web dump, and a label against a fresh read
function webTarget(app, url, spec, kind) {
  const last = /^@\d+$/.test(spec) && webLast(app);
  if (last) return webFind(last, spec, kind);
  if (!webRead(app, url)) return null; // JavaScript is blocked: the Accessibility path serves
  let r = js(app, url, false, webSearch(spec.replace(/^@/, ""), kind || ""));
  for (let i = 0; r === "none" && i < 40; i++) { pause(200); r = js(app, url, false, webSearch(spec.replace(/^@/, ""), kind || "")); } // pages add controls late: wait up to 8 s
  if (r === "none") throw new Error(`nothing on the page matches ${spec}; run mac dump`);
  if (r.startsWith("many")) throw new Error(`${spec} matches ${r.slice(5)} controls; use an @N from mac dump`);
  return JSON.parse(r);
}
const webObs = (d, app) => ({ items: d.items, context: d.context, where: { app, window: d.title, url: d.url },
  sig: JSON.stringify([d.url, d.title, d.items.map((it) => [it.ref, it.label, it.value, it.state]), d.context]) });

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
  const url = flag(args, "--url");
  if (cmd === "tab" && args[0]) { tab(app, args[0]); return console.log(`opened ${args[0]} in the agent's window of ${app}`); }
  if (cmd === "tabs") return console.log(js(app, "", true));
  if (cmd === "js") {
    const code = args.length ? args.join(" ") : readFileSync(0, "utf8");
    if (!code.trim()) throw new Error("js needs JavaScript as an argument or on stdin");
    return console.log(js(app, url, false, code));
  }
  if (cmd === "open") return ensureRunning(app).then(() => console.log(`${app} running`));
  if (cmd === "dump" && !args.includes("--ax")) {
    const w = webRead(app, url);
    if (w) {
      writeFileSync(lastFile(app), JSON.stringify({ web: true, items: w.items }));
      console.log(`${app} — "${w.title}" ${w.url} (scroll ${w.scroll.y}/${w.scroll.max})`);
      for (const it of w.items)
        console.log(`@${it.ref} [${it.role}] "${it.label}"` + (it.value ? ` = "${it.value}"` : "") + (it.state ? ` (${it.state})` : "") + (it.selected ? " (selected)" : "") + ` ${it.x},${it.y}`);
      if (w.context.length) console.log("text: " + w.context.join(" | "));
      return;
    }
  }
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
  if (cmd === "record" && args[0]) { // one window, even covered; returns at once and records in the background
    const secs = flag(args, "--seconds") || "30";
    if (!/^\d+(\.\d+)?$/.test(secs)) throw new Error("--seconds takes a number");
    spawn(driver(), ["record", app, args[0], secs], { detached: true, stdio: "ignore" }).unref();
    return console.log(`recording ${app}'s window for ${secs} s to ${args[0]}`);
  }
  const at = flag(args, "--at"), to = flag(args, "--to"), lines = flag(args, "--lines"), mods = flag(args, "--mods");
  const how = ["--right", "--double"].filter((f) => args.includes(f) && args.splice(args.indexOf(f), 1));
  const where = [...(at ? ["--at", at] : []), ...(to ? ["--to", to] : []), ...(lines ? ["--lines", lines] : []), ...(mods ? ["--mods", mods] : [])];
  if (cmd === "click" && at) return console.log(ax(["click", app, ...where, ...how]));
  if (cmd === "drag") return console.log(ax(["drag", app, ...where]));
  if (cmd === "scroll" && args[0] && !at && BROWSER.test(app) && webRead(app, url)) {
    const dir = args[0], n = +(lines || 5);
    if (args[1]) return console.log(`${webDo(app, url, "SHOW", webTarget(app, url, args[1]))} ${args[1]}`);
    if (dir === "up" || dir === "down") return console.log(webDo(app, url, "SCROLL_BY", null, String((dir === "down" ? 1 : -1) * n * 40)));
  }
  if (cmd === "scroll" && args[0]) return console.log(ax(["scroll", app, ...args.slice(0, 2), ...where, ...(args[1] ? was(app, args[1]) : [])]));
  const secret = flag(args, "--secret");
  const keys = args.includes("--keys") && args.splice(args.indexOf("--keys"), 1).length > 0;
  const real = args.includes("--real") && args.splice(args.indexOf("--real"), 1).length > 0;
  const [target, ...rest] = args;
  // a web page: act through JavaScript (--real: a real mouse click at the control, for pages
  // that ignore script clicks); a browser that blocks JavaScript falls through to Accessibility
  if (BROWSER.test(app) && !keys && !at && !how.length && !mods && (cmd === "click" || cmd === "type") && target) {
    const it = webTarget(app, url, target, cmd === "type" ? "TYPE_TEXT" : undefined);
    if (it) {
      if (cmd === "click" && real) {
        const p = JSON.parse(webDo(app, url, "LOCATE", it));
        return console.log(ax(["click", app, "--at", `${p.x},${p.y}`]).replace(/^clicked/, `clicked ${it.role} "${it.label}"`));
      }
      if (cmd === "click") return console.log(`${webDo(app, url, "CLICK", it)} ${it.role} "${it.label}"`);
      const text = secret ? process.env[secret] : rest.join(" ");
      if (!text) throw new Error(secret ? `--secret ${secret}: $${secret} is empty` : "type needs TEXT or --secret ENVVAR");
      return console.log(`${webDo(app, url, "TYPE_TEXT", it, text)} into "${it.label}"`);
    }
  }
  if (BROWSER.test(app) && cmd === "key" && /^(return|enter)$/i.test(target || "") && webRead(app, url)) return console.log(webDo(app, url, "PRESS_ENTER"));
  if (cmd === "click" && target) return console.log(ax(["click", app, target, ...was(app, target), ...how, ...where]));
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
  const web = !!webRead(o.app);
  await run({ key, o, surface: web ? `web page in ${o.app}` : `macOS app (${o.app})`, driver: { observe: observer(o.app), act: flowAct(o.app, web), scroll: false } });
}

// flowAct is the flow loop's action: the driver re-reads the window and refuses if the
// ref no longer names this control.
function flowAct(app, web) {
  if (web) return async (op, target, text) => { const r = webDo(app, undefined, op, target, text);
    return target ? `${r} ${target.role} "${target.label}"` : r; };
  return async (op, target, text) => {
    ax(["act", app, target ? target.ref : "0", op, "--was", target ? target.label : "", target ? target.role : ""], text || "");
    return op === "TYPE_TEXT" ? `typed a value into "${target.label}"` : op === "CLICK" ? `clicked ${target.role} "${target.label}"` : "pressed Enter";
  };
}

// observe reads the app once, and re-reads (up to 10 × 100 ms) while the window
// is still the one from before — an action's effect is given a moment to settle.
function observer(app) {
  const page = () => { const w = webRead(app); return w && webObs(w, app); };
  return async (before) => {
    if (BROWSER.test(app)) {
      let o = page();
      if (o) {
        for (let i = 0; before !== undefined && o.sig === before && i < 10; i++) { await sleep(100); o = page(); }
        return o;
      }
    }
    let d = dump(app), sig = JSON.stringify([d.window, d.items, d.context]);
    for (let i = 0; before !== undefined && sig === before && i < 10; i++) { // re-read only while unchanged
      await sleep(100);
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
  const observe = observer(app), web = !!webRead(app);
  const act = web ? async (s, item) => { webDo(app, undefined, s.op === "type" ? "TYPE_TEXT" : "CLICK", item, s.op === "type" ? s.text : "");
    return s.op === "type" ? `typed into "${item.label}"` : `clicked ${item.role} "${item.label}"`; } : async (s, item) => {
    ax(["act", app, item.ref, s.op === "type" ? "TYPE_TEXT" : "CLICK", "--was", item.label, item.role], s.op === "type" ? s.text : "");
    return s.op === "type" ? `typed into "${item.label}"` : `clicked ${item.role} "${item.label}"`;
  };
  const flowTo = (goal) => run({ key, o: { goal, steps: 15, minConf: 0.6, values: [], dryRun: false, allowRisky: false },
    surface: `macOS app (${app})`,
    driver: { observe, act: flowAct(app, web), scroll: web } });
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
