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
  if (p.recovery !== undefined && (!Number.isInteger(p.recovery) || p.recovery < 0 || p.recovery > 3)) bad(`"recovery" must be an integer 0 to 3`);
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
    if (keys.length !== 1 || !["click", "type", "key"].includes(keys[0])) bad(`${where} needs exactly one action among "click", "type", "key" (plus "post")`);
    const op = keys[0];
    if (typeof s[op] !== "string" || !s[op].trim()) bad(`${where}: "${op}" wants a control label or key combo`);
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

// runPlan drives a parsed plan. tools: { observe, act, flow, log } —
//   observe(beforeSig?) -> { items, context, where: { app, window }, sig }
//   act(step, item)     -> performs the step (item null for key combos)
//   flow(goal)          -> the flow loop; resolves if it reached DONE, throws on any stop
export async function runPlan(plan, tools, o = {}) {
  const log = tools.log || console.log;
  const dry = !!o.dryRun;
  const t0 = Date.now();
  const result = { ok: false, goal: plan.goal, steps: [], recoveries: 0, final: null, secs: 0 };
  if (dry) result.dryRun = true;
  let budget = plan.recovery, safetyStop = false, replanned = false;
  try {
    const d0 = await tools.observe();
    log(`${plan.steps.length}-step plan for "${plan.goal}" — ${JSON.stringify(d0.where)}`);
    // a recovery spends one unit of budget and replans the WHOLE goal from the
    // current state; if the flow loop stops (risky label, BLOCKED, low confidence)
    // nothing further is attempted: a stop is a person's answer, not drift
    const recover = async (why) => {
      if (dry) throw new Error(`${why} (dry run: nothing executed)`);
      if (safetyStop) throw new Error(`${why}; no further recovery after an earlier stop`);
      if (budget < 1) throw new Error(`${why}; the recovery budget is used up (plan "recovery": ${plan.recovery})`);
      budget--; result.recoveries++;
      log(`  recovery ${result.recoveries}: ${why}`);
      log(`  replanning "${plan.goal}" from the current window through the flow loop`);
      try { await tools.flow(plan.goal); }
      catch (e) { safetyStop = true; throw new Error(`recovery stopped: ${e.message}`); }
    };
    for (let i = 0; i < plan.steps.length && !replanned; i++) {
      const s = plan.steps[i], n = i + 1;
      let item = null, line = `${String(n).padStart(2)} plan ${s.op} "${s.target}"`;
      try {
        const d = await tools.observe(); // fresh read: the target is resolved now, never from an earlier dump
        if (s.op !== "key") item = resolve(d, s.target, s.op === "type" ? "TYPE_TEXT" : "CLICK");
      } catch (e) {
        if (dry) { log(`${line} → not on screen in a dry run: ${e.message}`); result.steps.push({ step: n, op: s.op, target: s.target, dryRun: true, note: e.message }); continue; }
        await recover(`step ${n}: ${e.message}`);
        replanned = true; // the flow loop owns the rest of the goal now
        break;
      }
      if (item) line += ` (@${item.ref} ${item.role})`;
      if (dry) { log(`${line} → dry run, not executed`); result.steps.push({ step: n, op: s.op, target: s.target, resolved: item ? `@${item.ref} "${item.label}"` : null, dryRun: true }); continue; }
      const ta = Date.now();
      await tools.act(s, item);
      const actMs = Date.now() - ta;
      const tv = Date.now();
      const d2 = await tools.observe(); // settle like flow: re-read while unchanged
      const verifyMs = Date.now() - tv;
      const post = check(d2, s.post);
      const row = { step: n, op: s.op, target: s.target, resolved: item ? `@${item.ref} "${item.label}"` : s.target, actMs, verifyMs, post };
      result.steps.push(row);
      if (post.every((p) => p.ok)) { log(`${line} → ${post.map(describe).join(", ")} (${actMs + verifyMs}ms)`); continue; }
      const failed = post.filter((p) => !p.ok).map(describe).join("; ");
      row.failed = failed;
      log(`${line} → MISMATCH after acting: ${failed} (window "${d2.where.window}")`);
      await recover(`step ${n}: ${failed}, not the window "${d2.where.window}" the plan expected`);
      replanned = true;
    }
    // the goal is checked only here, on a fresh read, against the caller's own
    // assertions — independently of every step and of any DONE above
    const finalCheck = async () => {
      const d = await tools.observe();
      result.final = { window: d.where.window, checks: check(d, plan.success) };
      return result.final.checks.every((c) => c.ok);
    };
    if (await finalCheck()) result.ok = true;
    else {
      const failed = result.final.checks.filter((c) => !c.ok).map(describe).join("; ");
      if (dry) result.error = `dry run: the goal assertions are not met on screen (${failed})`;
      else if (budget >= 1 && !safetyStop) {
        await recover(`after the plan, the goal is not on screen: ${failed}`);
        if (await finalCheck()) result.ok = true;
        else result.error = `goal not verified even after recovery: ${result.final.checks.filter((c) => !c.ok).map(describe).join("; ")}`;
      } else result.error = `goal not verified: ${failed}`;
    }
  } catch (e) { result.error = e.message; }
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
      log: () => {},
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
    ['{"goal":"g","steps":[{"click":"a","post":[{"window":"w"}]}],"success":[{"window":"w"}],"recovery":9}', /recovery/],
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
  const r6 = await runPlan(P({ recovery: 3, steps: [{ click: "General", post: [{ window: "About" }] }] }), stopFlow);
  assert.equal(r6.ok, false); assert.match(r6.error, /recovery stopped.*irreversible/);
  assert.equal(r6.recoveries, 1); // the stop ends it: budget 3, one try
  console.log("plan.mjs self-check ok");
}
