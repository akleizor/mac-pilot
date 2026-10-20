// The hybrid checkpoint behind `mac plan`. A plan is caller-supplied deterministic
// steps, each with observable postconditions; every step resolves its target on a
// fresh read, acts, and re-reads before the next step. The first mismatch stops
// the script and hands the CURRENT state to the same Jev loop `flow` uses — one
// bounded recovery, not a new framework. The goal itself is accepted only on the
// plan's own assertions against a fresh dump: a click's exit status, a step's
// postconditions or a recovery's DONE are never taken as success.
import { risky } from "./jev.mjs";

// An assertion states only what a dump can observe: the window's title, text that
// exists on screen, or text that must not be there. No shell, no callbacks.
const ASSERT = ["window", "exists", "absent"];

export function parsePlan(text) {
  const bad = (msg) => { throw new Error(`plan: ${msg}`); };
  let p;
  try { p = JSON.parse(text); } catch (e) { bad(`not valid JSON (${e.message})`); }
  if (typeof p !== "object" || p === null || Array.isArray(p)) bad("the top level must be a JSON object");
  for (const k of Object.keys(p)) if (!["goal", "steps", "success", "recovery"].includes(k)) bad(`unknown key "${k}"`);
  if (typeof p.goal !== "string" || !p.goal.trim()) bad(`"goal" (string) is required; a recovery replans toward it`);
  if (!Array.isArray(p.steps) || p.steps.length < 1 || p.steps.length > 20) bad(`"steps" must be a list of 1 to 20 steps`);
  if (!Array.isArray(p.success) || !p.success.length || p.success.length > 5) bad(`"success" must be a list of 1 to 5 assertions; the goal is accepted on these alone`);
  if (p.recovery !== undefined && p.recovery !== 0 && p.recovery !== 1) bad(`"recovery" is 0 or 1: at most one bounded recovery`);
  const asserts = (a, where) => {
    if (!Array.isArray(a) || !a.length || a.length > 5) bad(`${where} must be a list of 1 to 5 assertions`);
    return a.map((x) => {
      if (typeof x !== "object" || x === null || Array.isArray(x)) bad(`${where}: each assertion is an object`);
      const keys = Object.keys(x);
      if (keys.length !== 1 || !ASSERT.includes(keys[0])) bad(`${where}: each assertion is exactly one of ${ASSERT.map((k) => `"${k}"`).join(", ")}`);
      if (typeof x[keys[0]] !== "string" || !x[keys[0]].trim()) bad(`${where}: "${keys[0]}" wants a non-empty string`);
      return x;
    });
  };
  const steps = p.steps.map((s, i) => {
    const where = `step ${i + 1}`;
    if (typeof s !== "object" || s === null || Array.isArray(s)) bad(`${where} must be an object`);
    const keys = Object.keys(s).filter((k) => k !== "post" && k !== "text");
    // no "key" steps: return, space or cmd+delete press whatever is default or focused,
    // which no label check can see — keys stay manual commands
    if (keys.length !== 1 || !["click", "type"].includes(keys[0])) bad(`${where} needs exactly one action, "click" or "type" (plus "post"); keys are manual commands, never plan steps`);
    const op = keys[0];
    if (typeof s[op] !== "string" || !s[op].trim()) bad(`${where}: "${op}" wants a control label`);
    if (s[op].startsWith("@")) bad(`${where}: plans target labels, not @N refs; a ref goes stale between reads`);
    if (op === "type" && (typeof s.text !== "string" || !s.text)) bad(`${where}: "type" needs "text"`);
    if (op !== "type" && "text" in s) bad(`${where}: "text" belongs to "type" only`);
    if (risky(s[op]) || (op === "type" && risky(s.text)))
      bad(`${where} "${s[op]}" looks irreversible; a scripted plan never auto-confirms risky controls — run that step as a manual command`);
    if (!Array.isArray(s.post) || !s.post.length) bad(`${where} needs "post": what the window must show once this step has acted; without it a drift cannot be caught`);
    return { op, target: s[op], text: s.text, post: asserts(s.post, `${where} "post"`) };
  });
  return { goal: p.goal, steps, success: asserts(p.success, `"success"`), recovery: p.recovery ?? 1 };
}

// resolve mirrors the driver's rule: an exact label, else a unique substring,
// among the controls this step acts on. Nothing found or two matches refuses
// the step — the plan never guesses which control to press.
export function resolve(d, spec, kind) {
  const pool = d.items.filter((it) => it.kind === kind);
  const exact = pool.filter((it) => it.label === spec);
  const hits = exact.length ? exact : pool.filter((it) => it.label.toLowerCase().includes(spec.toLowerCase()));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`nothing matches "${spec}" in the current window ("${d.where.window}")`);
  throw new Error(`"${spec}" matches ${hits.length} controls (${hits.slice(0, 4).map((h) => `"${h.label}"`).join(", ")}); make the label unique`);
}

const describe = (a) => a.window !== undefined ? `window contains "${a.window}"` : a.exists !== undefined ? `"${a.exists}" on screen` : `"${a.absent}" not on screen`;

export function check(d, asserts) {
  const text = d.items.map((it) => it.label).concat(d.context).join("\n");
  return asserts.map((a) => {
    const k = Object.keys(a)[0];
    const ok = k === "window" ? d.where.window.includes(a[k])
      : k === "exists" ? text.includes(a[k])
      : !text.includes(a[k]) && !d.where.window.includes(a[k]);
    return { [k]: a[k], ok };
  });
}

// A generic confirm button decides whatever its dialog asks, so its own label says
// nothing; on a window whose text looks irreversible the plan refuses to press it.
const CONFIRM = /^(ok|yes|continue|confirm|allow|agree|i agree|accept|proceed|replace)$/i;

// safety judges the control a step RESOLVED to on the fresh read, not the label the
// plan was written with: "All Data" can resolve to "Delete All Data".
export function safety(d, item) {
  if (risky(item.label)) return `"${item.label}" looks irreversible`;
  const text = [d.where.window, ...d.context, ...d.items.map((it) => it.label)].join(" ");
  if (CONFIRM.test(item.label.trim()) && risky(text)) return `"${item.label}" would confirm a window that looks irreversible ("${d.where.window}")`;
  return null;
}

class SafetyStop extends Error {}
// the driver refuses a ref that no longer names the same control, before pressing
const STALE = /stale ref|has no window/;
const POLLS = 4, POLL_MS = 250; // the same 1 s bound flow's settle uses

// runPlan drives a parsed plan. tools: { observe, act, flow, log, wait? } —
//   observe(beforeSig?) -> { items, context, where: { app, window }, sig }; with
//                          beforeSig it re-reads while the window is unchanged
//   act(step, item)     -> performs the step; throws (pressing nothing) on a stale ref
//   flow(goal)          -> the flow loop; resolves if it reached DONE, throws on any stop
export async function runPlan(plan, tools, o = {}) {
  const log = tools.log || console.log;
  const wait = tools.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const dry = !!o.dryRun;
  const t0 = Date.now();
  const result = { ok: false, goal: plan.goal, steps: [], recoveries: 0, final: null, secs: 0 };
  if (dry) result.dryRun = true;
  // read after an action until the assertions hold or the bounded settle runs out:
  // an ordinary async update (sidebar first, pane title later) is not a mismatch
  const settle = async (beforeSig, asserts) => {
    let d = await tools.observe(beforeSig), c = check(d, asserts);
    for (let k = 0; k < POLLS && !c.every((x) => x.ok); k++) { await wait(POLL_MS); d = await tools.observe(); c = check(d, asserts); }
    return { d, c };
  };
  // the one recovery replans the WHOLE goal from the current state; a flow stop
  // (risky label, BLOCKED, low confidence) is a person's answer, not drift
  const recover = async (why) => {
    if (dry) throw new Error(`${why} (dry run: nothing executed)`);
    if (result.recoveries >= plan.recovery) throw new Error(`${why}; ${plan.recovery ? "the one recovery is used up" : 'no recovery (plan "recovery": 0)'}`);
    result.recoveries++;
    log(`  recovery: ${why}`);
    log(`  replanning "${plan.goal}" from the current window through the flow loop`);
    try { await tools.flow(plan.goal); }
    catch (e) { throw new SafetyStop(`recovery stopped: ${e.message}`); }
  };
  try {
    const d0 = await tools.observe();
    log(`${plan.steps.length}-step plan for "${plan.goal}" — ${JSON.stringify(d0.where)}`);
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i], n = i + 1;
      let item, d, line = `${String(n).padStart(2)} plan ${s.op} "${s.target}"`;
      try {
        d = await tools.observe(); // fresh read: the target is resolved now, never from an earlier dump
        item = resolve(d, s.target, s.op === "type" ? "TYPE_TEXT" : "CLICK");
      } catch (e) {
        if (dry) { log(`${line} → not on screen in a dry run: ${e.message}`); result.steps.push({ step: n, op: s.op, target: s.target, dryRun: true, note: e.message }); continue; }
        result.steps.push({ step: n, op: s.op, target: s.target, failed: e.message });
        await recover(`step ${n}: ${e.message}`);
        break; // the flow loop owns the rest of the goal now
      }
      line += ` (@${item.ref} ${item.role} "${item.label}")`;
      const unsafe = safety(d, item);
      if (unsafe) {
        result.steps.push({ step: n, op: s.op, target: s.target, resolved: `@${item.ref} "${item.label}"`, blocked: unsafe });
        log(`${line} → SAFETY STOP: ${unsafe}; nothing pressed, no recovery`);
        throw new SafetyStop(`step ${n}: ${unsafe}; a plan never presses it — run that step as a manual command`);
      }
      if (dry) { log(`${line} → dry run, not executed`); result.steps.push({ step: n, op: s.op, target: s.target, resolved: `@${item.ref} "${item.label}"`, dryRun: true }); continue; }
      const ta = Date.now();
      try { await tools.act(s, item); }
      catch (e) {
        result.steps.push({ step: n, op: s.op, target: s.target, resolved: `@${item.ref} "${item.label}"`, failed: `driver: ${e.message}` });
        if (!STALE.test(e.message)) throw e; // not drift: stop as the driver said
        log(`${line} → the control changed before the press (${e.message}); nothing pressed`);
        await recover(`step ${n}: "${item.label}" went stale before the press`);
        break;
      }
      const actMs = Date.now() - ta, tv = Date.now();
      const { d: d2, c: post } = await settle(d.sig, s.post);
      const verifyMs = Date.now() - tv;
      const row = { step: n, op: s.op, target: s.target, resolved: `@${item.ref} "${item.label}"`, actMs, verifyMs, post };
      result.steps.push(row);
      if (post.every((p) => p.ok)) { log(`${line} → ${post.map(describe).join(", ")} (${actMs + verifyMs}ms)`); continue; }
      row.failed = post.filter((p) => !p.ok).map(describe).join("; ");
      log(`${line} → MISMATCH after acting: ${row.failed} (window "${d2.where.window}")`);
      await recover(`step ${n}: ${row.failed}, not the window "${d2.where.window}" the plan expected`);
      break;
    }
    // the goal is checked only here, on fresh reads, against the caller's own
    // assertions — independently of every step and of any DONE above
    const finalCheck = async () => {
      const { d, c } = await settle(undefined, plan.success);
      result.final = { window: d.where.window, checks: c };
      return c.every((x) => x.ok);
    };
    const unmet = () => result.final.checks.filter((c) => !c.ok).map(describe).join("; ");
    if (await finalCheck()) result.ok = true;
    else if (dry) result.error = `dry run: the goal assertions are not met on screen (${unmet()})`;
    else if (result.recoveries < plan.recovery) {
      await recover(`after the plan, the goal is not on screen: ${unmet()}`);
      if (await finalCheck()) result.ok = true;
      else result.error = `goal not verified even after recovery: ${unmet()}`;
    } else result.error = `goal not verified: ${unmet()}`;
  } catch (e) {
    result.error = e.message;
    if (e instanceof SafetyStop) result.stopped = true;
  }
  result.secs = +((Date.now() - t0) / 1000).toFixed(1);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) { // self-check: `node plan.mjs`
  const assert = (await import("node:assert")).strict;
  const dump = (window, labels, context = []) => ({
    where: { app: "System Settings", window }, sig: window + labels.join(),
    items: labels.map((l, i) => ({ ref: String(i + 1), role: l === "Field" ? "TextField" : "Button", label: l, kind: l === "Field" ? "TYPE_TEXT" : "CLICK" })),
    context,
  });
  // a scripted surface: each observe() returns the next dump (or holds the last);
  // act moves the script on; flow stands in for the Jev loop
  const surface = (dumps, onAct, onFlow) => {
    let i = 0;
    return {
      observe: async () => dumps[Math.min(i, dumps.length - 1)],
      act: async () => { onAct?.(); i++; },
      flow: async (goal) => { onFlow?.(goal); i = dumps.length - 1; }, // recovery "reaches DONE"
      log: () => {}, wait: async () => {},
    };
  };
  const P = (over = {}) => parsePlan(JSON.stringify({ goal: "Open About", steps: [{ click: "General", post: [{ window: "General" }] }, { click: "About", post: [{ window: "About" }] }], success: [{ window: "About" }, { exists: "macOS" }], ...over }));
  // malformed plans are refused before anything runs
  for (const [text, msg] of [
    ["{}", /"goal"/], ['{"goal":"g"}', /"steps"/], ['{"goal":"g","steps":[],"success":[]}', /"steps"/],
    ['{"goal":"g","steps":[{"click":"a"}],"success":[{"window":"w"}]}', /"post"/],
    ['{"goal":"g","steps":[{"click":"a","post":[]}],"success":[{"window":"w"}]}', /"post"/],
    ['{"goal":"g","steps":[{"click":"@3","post":[{"window":"w"}]}],"success":[{"window":"w"}]}', /@N/],
    ['{"goal":"g","steps":[{"click":"a","post":[{"window":"w"}]}],"success":[{"window":"w"}],"nope":1}', /unknown key/],
    ['{"goal":"g","steps":[{"type":"f","post":[{"window":"w"}]}],"success":[{"window":"w"}]}', /"text"/],
    ['{"goal":"g","steps":[{"click":"a","post":[{"window":"w"}]}],"success":[{"shell":"ls"}]}', /exactly one/],
    ['{"goal":"g","steps":[{"click":"a","post":[{"window":"w"}]}],"success":[{"window":"w"}],"recovery":9}', /0 or 1/],
    ['{"goal":"g","steps":[{"click":"a","post":[{"window":"w"}]}],"success":[{"window":"w"}],"recovery":2}', /0 or 1/],
    ['{"goal":"g","steps":[{"key":"return","post":[{"window":"w"}]}],"success":[{"window":"w"}]}', /keys are manual/],
    ['{"goal":"g","steps":[{"key":"cmd+delete","post":[{"window":"w"}]}],"success":[{"window":"w"}]}', /keys are manual/],
  ]) assert.throws(() => parsePlan(text), msg, text);
  // a risky step is refused before the first read
  assert.throws(() => P({ steps: [{ click: "Delete All Data", post: [{ window: "w" }] }] }), /irreversible/);
  assert.throws(() => P({ steps: [{ type: "Field", text: "unsubscribe now", post: [{ window: "w" }] }] }), /irreversible/);
  // stale or ambiguous controls are refused, never guessed
  assert.throws(() => resolve(dump("w", ["a", "b"]), "c", "CLICK"), /nothing matches/);
  assert.throws(() => resolve(dump("w", ["Network", "Network"]), "Net", "CLICK"), /matches 2/);
  assert.equal(resolve(dump("w", ["General", "Wi-Fi"]), "general", "CLICK").label, "General");
  // mismatch with no budget: the step acts once, fails, never calls flow
  let acted = 0, flowed = 0;
  const r1 = await runPlan(P({ recovery: 0, steps: [{ click: "General", post: [{ window: "About" }] }] }),
    surface([dump("Keyboard", ["General"]), dump("Keyboard", ["General"])], () => acted++, () => flowed++));
  assert.equal(acted, 1); assert.equal(flowed, 0); assert.equal(r1.ok, false);
  assert.match(r1.error, /step 1.*window contains "About"/);
  // bounded fallback: the mismatch spends the one recovery, the steps after it are
  // not re-run, and the goal is still checked independently on a fresh read
  acted = 0; flowed = 0;
  const r2 = await runPlan(P({ recovery: 1, steps: [
    { click: "General", post: [{ window: "General" }] },
    { click: "About", post: [{ window: "About" }] },
    { click: "Storage", post: [{ window: "Storage" }] },
  ] }), surface(
    [dump("Keyboard", ["General"]), dump("General", ["About"]), dump("General", ["About"]), dump("About", ["macOS Sequoia"], ["macOS", "version"])],
    () => acted++, (g) => { flowed++; assert.equal(g, "Open About"); }));
  assert.equal(acted, 2); assert.equal(flowed, 1); assert.equal(r2.recoveries, 1);
  assert.equal(r2.steps.length, 2); // step 3 was never attempted after the replan
  assert.equal(r2.ok, true); assert.equal(r2.final.window, "About");
  // final mismatch: every step passed, the goal check fails, one recovery, still fails
  flowed = 0;
  const r3 = await runPlan(P({ recovery: 1, success: [{ window: "Storage" }] }),
    surface([dump("Keyboard", ["General"]), dump("General", ["About"]), dump("About", ["macOS"], ["macOS"])], () => {}, () => flowed++));
  assert.equal(flowed, 1); assert.equal(r3.ok, false); assert.match(r3.error, /even after recovery/);
  // budget exhausted: a failed final check never triggers a second flow run
  flowed = 0;
  const r4 = await runPlan(P({ recovery: 0, success: [{ window: "Storage" }] }),
    surface([dump("Keyboard", ["General"]), dump("General", ["About"]), dump("About", ["macOS"], ["macOS"])], () => {}, () => flowed++));
  assert.equal(flowed, 0); assert.equal(r4.ok, false); assert.match(r4.error, /budget is used up|goal not verified/);
  // dry run: resolves and validates, but never acts and never recovers
  acted = 0; flowed = 0;
  const r5 = await runPlan(P({ recovery: 1 }), surface([dump("Keyboard", ["General"])], () => acted++, () => flowed++), { dryRun: true });
  assert.equal(acted, 0); assert.equal(flowed, 0); assert.equal(r5.dryRun, true);
  assert.equal(r5.steps[0].resolved, '@1 "General"'); assert.equal(r5.steps[1].note !== undefined, true);
  // a recovery that stops (risky label, BLOCKED) is final: no second attempt
  const stopFlow = { observe: surface([dump("Keyboard", ["General"]), dump("Keyboard", ["General"])]).observe,
    act: () => {}, flow: async () => { throw new Error('"Reset" looks irreversible'); }, log: () => {} };
  const r6 = await runPlan(P({ recovery: 1, steps: [{ click: "General", post: [{ window: "About" }] }] }), stopFlow);
  assert.equal(r6.ok, false); assert.match(r6.error, /recovery stopped.*irreversible/);
  assert.equal(r6.recoveries, 1); assert.equal(r6.stopped, true); // the stop ends it: no final-check recovery
  // the RESOLVED control is gated, not the plan's wording: "All Data" resolving to
  // "Delete All Data" stops outright — nothing pressed, no recovery, even in a dry run
  for (const dryRun of [false, true]) {
    acted = 0; flowed = 0;
    const r = await runPlan(P({ steps: [{ click: "All Data", post: [{ window: "w" }] }], success: [{ window: "w" }] }),
      surface([dump("w", ["Delete All Data"])], () => acted++, () => flowed++), { dryRun });
    assert.equal(acted, 0); assert.equal(flowed, 0); assert.equal(r.ok, false); assert.equal(r.stopped, true);
    assert.match(r.error, /"Delete All Data" looks irreversible/);
  }
  // a generic confirm on a window that looks irreversible is a safety stop; on a plain one it is pressed
  acted = 0; flowed = 0;
  const r7 = await runPlan(P({ steps: [{ click: "OK", post: [{ window: "w" }] }], success: [{ window: "w" }] }),
    surface([dump("w", ["OK", "Cancel"], ["Erase all content and settings?"])], () => acted++, () => flowed++));
  assert.equal(acted, 0); assert.equal(flowed, 0); assert.equal(r7.stopped, true); assert.match(r7.error, /would confirm/);
  const r8 = await runPlan(P({ steps: [{ click: "OK", post: [{ window: "w" }] }], success: [{ window: "w" }] }),
    surface([dump("w", ["OK", "Cancel"], ["Apply the new theme?"])], () => acted++));
  assert.equal(acted, 1); assert.equal(r8.ok, true);
  // a stale ref is drift: the driver pressed nothing, the one recovery replans; any
  // other driver error stops without recovering
  for (const [msg, recovered] of [["stale ref 1", true], ["Accessibility is not granted", false]]) {
    flowed = 0;
    const t = surface([dump("Keyboard", ["General"]), dump("About", ["macOS"], ["macOS"])], null, () => flowed++);
    const r = await runPlan(P(), { ...t, act: async () => { throw new Error(msg); } });
    assert.equal(flowed, recovered ? 1 : 0); assert.equal(r.ok, recovered); assert.equal(r.steps.length, 1);
    if (!recovered) assert.match(r.error, /not granted/);
  }
  // postconditions settle: the read after the press passes the pre-press signature,
  // and an async update (sidebar first, title later) is polled within the bound, not a mismatch
  const seq = [dump("Keyboard", ["General"]), dump("Keyboard", ["General", "x"]), dump("General", ["About"])];
  let at = 0; const sigs = []; flowed = 0;
  const r9 = await runPlan(P({ steps: [{ click: "General", post: [{ window: "General" }] }], success: [{ window: "General" }] }), {
    observe: async (before) => { sigs.push(before); return seq[Math.min(at === 0 ? 0 : at++, seq.length - 1)]; },
    act: async () => { at = 1; }, flow: async () => { flowed++; }, log: () => {}, wait: async () => {} });
  assert.equal(r9.ok, true); assert.equal(flowed, 0); assert.ok(sigs.includes(seq[0].sig));
  // one recovery at most: a step mismatch spends it, a failed goal after it never calls flow again
  flowed = 0;
  const r10 = await runPlan(P({ recovery: 1, success: [{ window: "Storage" }] }),
    surface([dump("Keyboard", ["General"]), dump("Keyboard", ["General"])], () => {}, () => flowed++));
  assert.equal(flowed, 1); assert.equal(r10.ok, false); assert.equal(r10.recoveries, 1);
  console.log("plan.mjs self-check ok");
}
