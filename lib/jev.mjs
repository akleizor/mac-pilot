// The Jev decision loop behind `mac-pilot flow`. Each cycle observes the surface
// once, asks TypeSafe's Jev (a non-generative choice model, ~0.3 s) for the
// next operation and target in ONE request, and acts through the driver.
//
// Jev only chooses among observed refs: model output never becomes selectors,
// URLs or text. Text comes from caller-supplied values picked by name. Low
// confidence, BLOCKED, a risky label or a stuck surface stops with the choices.
//
// A driver supplies:
//   observe(prevSig?) -> { items: [{ ref, role, label, kind: CLICK|TYPE_TEXT, value?, state?, selected? }],
//                          context: [string], where: object, sig: string }
//                        (with prevSig: wait until the surface settles after an action)
//   act(op, item?, text?) -> short description of what was done; throws "stale ref N"
//                            (pressing nothing) when the ref no longer names the same control
//   scroll: whether SCROLL_DOWN/UP are offered

// TYPESAFE_URL points the loop at another server speaking the same API, such as a
// local jeff-serve (github.com/firelex/jeff); TYPESAFE_MODEL picks its model or adapter.
// The key is $TYPESAFE_API_KEY (https://typesafe.ai).
// A decision endpoint is pluggable: set DECISION_URL (OpenAI-compatible, e.g. a
// company gateway or local model) + DECISION_MODEL to drive the loop with a normal
// chat model instead of Jev — the model only picks among the listed options.
const JEV_URL = process.env.TYPESAFE_URL || "https://api.typesafe.ai/v1/systemone";
const OPENAI = !!process.env.DECISION_URL;
const LOCAL = !OPENAI && !JEV_URL.startsWith("https://api.typesafe.ai/");
const RISKY = ["delete", "remove", "erase", "reset", "sign out", "log out", "logout", "buy", "purchase",
  "subscribe", "pay ", "checkout", "place order", "confirm payment", "uninstall", "unsubscribe", "send ",
  "move to trash", "empty trash", "restart", "shut down", "turn off"];

// a stale ref means the control moved between the read and the press and nothing was
// pressed: the loop re-reads the CURRENT surface and decides again, at most this many
// times per run, each spending a cycle of the step budget; the old ref is never retried
const STALE = /stale ref/, STALE_REREADS = 2;

export const risky = (label) => RISKY.some((w) => (label.toLowerCase() + " ").includes(w));

export function validChoice(a, ids) {
  if (!a || !ids.has(a.choice) || Object.keys(a.probabilities || {}).length !== ids.size) return false;
  const sum = Object.values(a.probabilities).reduce((s, p) => s + p, 0);
  return Math.abs(sum - 1) <= 0.02;
}

// parseArgs reads the shared flags; `flags` names the driver's own flags that take a value.
export function parseArgs(argv, flags, usage) {
  const o = { goal: "", steps: 15, minConf: 0.6, values: [], dryRun: false, allowRisky: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--steps") o.steps = +next();
    else if (a === "--min-conf") o.minConf = +next();
    else if (flags.includes(a)) o[a.slice(2)] = next();
    else if (a === "--value" || a === "--secret") {
      const v = next(), k = v.indexOf("=");
      if (k < 1) throw new Error(`${a} wants NAME=TEXT`);
      o.values.push({ name: v.slice(0, k), text: v.slice(k + 1) });
    } else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--allow-risky") o.allowRisky = true;
    else if (o.goal) throw new Error(`one goal only; quote it (extra "${a}")`);
    else o.goal = a;
  }
  if (!o.goal) throw new Error(usage);
  return o;
}

// startKey warms the TLS connection to Jev so it overlaps the caller's startup;
// the returned promise is awaited at the first Jev call.
export function startKey(envKey = process.env.TYPESAFE_API_KEY) {
  fetch(OPENAI ? process.env.DECISION_URL : JEV_URL, { method: "HEAD" }).catch(() => {});
  if (OPENAI) return Promise.resolve(process.env.DECISION_KEY || "");
  if (envKey || LOCAL) return Promise.resolve(envKey || "");
  return Promise.reject(new Error("no decision model: set TYPESAFE_API_KEY, or DECISION_URL+DECISION_MODEL for an OpenAI-compatible one"));
}

async function jevAsk(key, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(JEV_URL, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
    if ([429, 503, 529].includes(r.status) && attempt < 2) { await new Promise((s) => setTimeout(s, 500 << attempt)); continue; }
    if (!r.ok) throw new Error(`Jev returned HTTP ${r.status}; no action executed`);
    return (await r.json()).answers;
  }
}

// openaiAsk serves the same {answers:{q:{choice,probabilities}}} shape from any
// OpenAI-compatible chat endpoint: one completion per choice question, JSON only,
// the model restricted to the listed option keys. No selectors or text are invented.
async function openaiAsk(key, body) {
  const base = process.env.DECISION_URL.replace(/\/+$/, "");
  const url = /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
  const answers = {};
  for (const [name, q] of Object.entries(body.questions)) {
    const keys = Object.keys(q.criteria);
    const sys = "You make one bounded choice. Reply with JSON only: "
      + '{"choice": "<one option key>", "probabilities": {"<key>": number}} over EXACTLY these keys, summing to 1. '
      + "Pick the single key that best fits. Never invent a key.";
    const user = JSON.stringify({ ...q.instructions, state: body.state,
      options: q.criteria }, null, 0);
    const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: body.model, temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: user }] }) });
    if (!r.ok) throw new Error(`decision model HTTP ${r.status}; no action executed`);
    let parsed;
    try { parsed = JSON.parse((await r.json()).choices[0].message.content); } catch { throw new Error("decision model did not return JSON"); }
    let choice = keys.includes(parsed.choice) ? parsed.choice : keys[0];
    let probs = {};
    for (const k of keys) probs[k] = Number(parsed.probabilities?.[k]) || 0;
    const sum = Object.values(probs).reduce((s, p) => s + p, 0);
    if (sum <= 0) probs = Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0]));
    else for (const k of keys) probs[k] /= sum; // normalize so validChoice passes
    answers[name] = { choice, probabilities: probs };
  }
  return answers;
}

const backendAsk = (key, body) => (OPENAI ? openaiAsk : jevAsk)(key, body);

// askMerged serves a local Jeff: it costs one forward pass per question, each
// re-reading the whole state, so operation and target become ONE choice
// ("click_12", "scroll_down", "done", ...) and the answer is split back into
// the operation and *_target heads the loop reads. Keys are never bare numbers
// (Jeff's documented rule). A second question is asked only to pick among
// several supplied values.
async function askMerged(key, { goal, rules, where, ops, heads, byRef, questions, state }) {
  const criteria = {}, back = {};
  for (const [op, text] of Object.entries(ops)) {
    if (op === "CLICK" || op === "TYPE_TEXT") continue;
    criteria[op.toLowerCase()] = text;
    back[op.toLowerCase()] = [op];
  }
  for (const [kind, crit] of Object.entries(heads))
    for (const [ref, text] of Object.entries(crit)) {
      const k = `${kind === "CLICK" ? "click" : "type_into"}_${ref}`;
      criteria[k] = `${kind === "CLICK" ? "Click" : "Type the supplied value into"} ${text}`;
      back[k] = [kind, ref];
    }
  const merged = { action: { type: "choice", criteria, instructions: { goal, rules, where } } };
  if (questions.type_text_value && Object.keys(questions.type_text_value.criteria).length > 1)
    merged.type_text_value = { ...questions.type_text_value,
      criteria: Object.fromEntries(Object.entries(questions.type_text_value.criteria).map(([k, v]) => [`value_${k}`, v])) };
  const a = await backendAsk(key, { model: process.env.DECISION_MODEL || process.env.TYPESAFE_MODEL || "jeff-latest", questions: merged, state });
  const probs = a.action.probabilities, byOp = {}, byTarget = {};
  for (const [k, p] of Object.entries(probs)) {
    const [op, ref] = back[k];
    byOp[op] = (byOp[op] || 0) + p;
    if (ref) (byTarget[op] ||= {})[ref] = p;
  }
  const [op, ref] = back[a.action.choice];
  const out = { operation: { choice: op, confidence: byOp[op], probabilities: Object.fromEntries(Object.keys(ops).map((k) => [k, byOp[k] || 0])) } };
  for (const [kind, t] of Object.entries(byTarget)) {
    const total = Object.values(t).reduce((x, y) => x + y, 0) || 1;
    const norm = Object.fromEntries(Object.entries(t).map(([r, p]) => [r, p / total]));
    const pick = kind === op ? ref : Object.entries(norm).sort((x, y) => y[1] - x[1])[0][0];
    out[`${kind.toLowerCase()}_target`] = { choice: pick, confidence: norm[pick], probabilities: norm };
  }
  if (merged.type_text_value) {
    const v = a.type_text_value;
    out.type_text_value = { choice: v.choice.slice(6), confidence: v.confidence };
  } else if (questions.type_text_value) out.type_text_value = { choice: "1", confidence: 1 };
  return out;
}

const describe = (it) => `${it.role} "${it.label}"` + (it.value ? ` (current text: "${it.value}")` : "") +
  (it.state ? ` (${it.state})` : "") + (it.selected ? " (selected)" : "");

// run drives the loop until DONE; it throws with the choices on any stop.
export async function run({ key, o, surface, driver, log = console.log }) { // key: string or startKey() promise
  const rules = `You operate a ${surface} toward the goal. Choose the single next operation that makes ` +
    "progress. Prefer what is visible over scrolling. Choose DONE only when the surface shows every " +
    "requirement of the goal already satisfied. Choose BLOCKED only when an error, a captcha, or a " +
    "dialog asking to grant a permission, pay, delete or sign out stands in the way, or nothing listed " +
    "can progress; settings pages that merely describe permissions are not blocks. Never repeat " +
    "an action from recent_actions unless the surface changed because of it.";
  const start = Date.now(), history = [], secs = () => ((Date.now() - start) / 1000).toFixed(1);
  let obs = await driver.observe(), lastField = false, stale = 0;
  const done = () => `${history.length} action(s)${stale ? `, ${stale} stale re-read(s)` : ""}`;
  for (let step = 1; step <= o.steps; step++) {
    const { items, context, where } = obs;
    const ops = { DONE: "Every requirement of the goal is visibly satisfied.",
      BLOCKED: "Nothing supported can progress, or a risky/unknown prompt needs a person." };
    if (driver.scroll) {
      ops.SCROLL_DOWN = "Scroll down: nothing listed advances the goal and what is needed is likely further down.";
      ops.SCROLL_UP = "Scroll up: nothing listed advances the goal and what is needed is likely further up.";
    }
    const heads = {}, byRef = {};
    for (const it of items) {
      if (it.kind === "TYPE_TEXT" && !o.values.length) continue;
      (heads[it.kind] ||= {})[it.ref] = describe(it);
      byRef[it.ref] = it;
    }
    if (heads.CLICK) ops.CLICK = "Click one of the listed items: one of them is the next step toward the goal.";
    if (heads.TYPE_TEXT) ops.TYPE_TEXT = "Replace the text of an input field with one of the supplied values.";
    if (lastField) ops.PRESS_ENTER = "Submit the field just typed into by pressing Enter.";
    const instructions = { goal: o.goal, rules };
    // the operation head must see what is listed, or it cannot tell CLICK from BLOCKED or scrolling
    const questions = { operation: { type: "choice", criteria: ops, instructions: { ...instructions, where,
      on_screen_items: Object.values(byRef).map((it) => `${it.kind.toLowerCase()} "${it.label}"`),
      fields: items.filter((it) => it.kind === "TYPE_TEXT").map((it) => `"${it.label}" holds "${it.value || ""}"`) } } };
    for (const [kind, crit] of Object.entries(heads))
      questions[`${kind.toLowerCase()}_target`] = { type: "choice", criteria: crit, instructions: { ...instructions, operation: kind } };
    if (heads.TYPE_TEXT) questions.type_text_value = { type: "choice", instructions: { goal: o.goal, rule: "Pick the supplied value that belongs in the chosen field." },
      criteria: Object.fromEntries(o.values.map((v, n) => [String(n + 1), `value named ${v.name}`])) }; // the value itself never leaves the Mac
    const t0 = Date.now();
    const state = { visible_text: context, recent_actions: history.slice(-8) };
    const ans = (LOCAL || OPENAI) ? await askMerged(await key, { goal: o.goal, rules, where, ops, heads, byRef, questions, state })
      : await jevAsk(await key, { model: process.env.TYPESAFE_MODEL || "jev-latest", questions, state });
    const op = ans.operation;
    if (!validChoice(op, new Set(Object.keys(ops)))) throw new Error(`invalid Jev answer ${JSON.stringify(op)}`);
    let line = `${String(step).padStart(2)} jev ${String(Date.now() - t0).padStart(4)}ms ${op.choice.padEnd(11)} p=${op.confidence.toFixed(2)}`;
    const stop = (msg) => {
      log(`${line}  ${msg}`);
      for (const it of items) log(`   @${it.ref} [${it.kind}] ${describe(it)}`);
      throw new Error(`${msg} after ${done()}, ${secs()}s`);
    };
    // a plurality pick on a step is cheap to undo (risky clicks are gated below);
    // only DONE needs the full bar, since it ends the run
    const floor = op.choice === "DONE" ? o.minConf : Math.min(o.minConf, 0.3);
    if (op.confidence < floor) stop(`low confidence (${op.confidence.toFixed(2)} < ${floor}); choices above`);
    let target;
    if (op.choice === "CLICK" || op.choice === "TYPE_TEXT") {
      const ta = ans[`${op.choice.toLowerCase()}_target`];
      if (!validChoice(ta, new Set(Object.keys(heads[op.choice])))) throw new Error("invalid Jev target");
      target = byRef[ta.choice];
      line += `  @${target.ref} ${target.role} "${target.label}" p=${ta.confidence.toFixed(2)}`;
      if (ta.confidence < Math.min(o.minConf, 0.4)) stop(`low target confidence (${ta.confidence.toFixed(2)}); choices above`);
      if (op.choice === "CLICK" && risky(target.label) && !o.allowRisky) stop(`"${target.label}" looks irreversible; rerun with --allow-risky if intended`);
    }
    if (history.length >= 4 && history.slice(-4).every((h) => !h.changed)) stop("the last actions are not changing anything; choices above");
    if (op.choice === "DONE") {
      log(line);
      log(`done: ${done()} in ${secs()}s — ${JSON.stringify(where)} (verify independently)`);
      return;
    }
    if (op.choice === "BLOCKED") stop("blocked; choices above");
    log(line);
    if (o.dryRun) { log("dry run: nothing executed"); return; }
    let text;
    if (op.choice === "TYPE_TEXT") {
      const v = o.values[+ans.type_text_value.choice - 1];
      text = v.text;
      log(`           value=${v.name}`);
    }
    let act;
    try { act = await driver.act(op.choice, target, text); }
    catch (e) { // only drift is re-read; risky, BLOCKED, low confidence and other driver errors stopped above or stop here
      if (!STALE.test(e.message)) throw e;
      if (stale >= STALE_REREADS) throw new Error(`${e.message}: nothing pressed; ${STALE_REREADS} stale re-reads used up after ${done()}, ${secs()}s`);
      stale++;
      log(`           ${e.message}: nothing pressed; re-reading the current surface (${stale}/${STALE_REREADS})`);
      obs = await driver.observe();
      continue;
    }
    lastField = op.choice === "TYPE_TEXT";
    const next = await driver.observe(obs.sig);
    history.push({ action: act, changed: next.sig !== obs.sig });
    obs = next;
  }
  throw new Error(`step budget (${o.steps}) used up without DONE after ${done()}, ${secs()}s`);
}

if (import.meta.url === `file://${process.argv[1]}`) { // self-check: `node jev.mjs`
  const assert = (await import("node:assert")).strict;
  assert.ok(risky("Delete account") && risky("Send") && risky("Move to Trash") && !risky("Sendai news"));
  assert.ok(validChoice({ choice: "a", probabilities: { a: 0.7, b: 0.3 } }, new Set(["a", "b"])));
  assert.ok(!validChoice({ choice: "c", probabilities: { a: 0.7, b: 0.3 } }, new Set(["a", "b"])));
  assert.deepEqual(parseArgs(["g", "--app", "Notes", "--value", "q=a=b"], ["--app"], "u"),
    { goal: "g", steps: 15, minConf: 0.6, values: [{ name: "q", text: "a=b" }], dryRun: false, allowRisky: false, app: "Notes" });
  assert.throws(() => parseArgs([], [], "usage!"), /usage!/);
  // stale refs: a fake Jev clicks "Go Back" (or "Reset") until the window is General
  const reply = (answers) => ({ ok: true, status: 200, json: async () => ({ answers }) });
  const pick = (crit, c) => { const ks = Object.keys(crit);
    return { choice: c, confidence: 0.9, probabilities: Object.fromEntries(ks.map((k) => [k, ks.length === 1 ? 1 : k === c ? 0.9 : 0.1 / (ks.length - 1)])) }; };
  let asks = 0;
  globalThis.fetch = async (_u, req) => { // serves both the Jev shape and the merged one (local or OpenAI-compatible)
    asks++;
    const body = JSON.parse(req.body), u = body.messages && JSON.parse(body.messages[1].content); // OpenAI-compatible: one question per call
    const q = u ? { action: { criteria: u.options, instructions: u } } : body.questions, m = q.action;
    const clicks = m ? Object.fromEntries(Object.entries(m.criteria).filter(([k]) => k.startsWith("click_")).map(([k, v]) => [k.slice(6), v]))
      : q.click_target?.criteria || {};
    const want = (m || q.operation).instructions.where.window === "General" ? "DONE"
      : Object.keys(clicks).find((r) => /Go Back|Reset/.test(clicks[r]));
    const merged = m && pick(m.criteria, want === "DONE" ? "done" : `click_${want}`);
    if (u) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(merged) } }] }) };
    if (m) return reply({ action: merged });
    return reply({ operation: pick(q.operation.criteria, want === "DONE" ? "DONE" : "CLICK"),
      ...(q.click_target && { click_target: pick(q.click_target.criteria, want === "DONE" ? Object.keys(q.click_target.criteria)[0] : want) }) });
  };
  const view = (window, ref, label = "Go Back") => ({ where: { app: "System Settings", window }, context: [], sig: window + ref,
    items: [{ ref: "1", role: "Button", label: "Wi-Fi", kind: "CLICK" }, { ref, role: "Button", label, kind: "CLICK" }] });
  const fake = (views, act) => { let i = 0; const acts = [], seen = [];
    return { acts, seen, driver: { scroll: false, observe: async () => { const v = views[Math.min(i++, views.length - 1)]; seen.push(v); return v; },
      act: async (op, t) => { acts.push(t); return act(t, acts.length); } } }; };
  const o = { goal: "Open General", steps: 15, minConf: 0.6, values: [], dryRun: false, allowRisky: false }, lines = [];
  // first press refused as stale: nothing pressed, the CURRENT surface is re-read, Jev decides again on the fresh ref
  let f = fake([view("Wi-Fi", "47"), view("Wi-Fi", "49"), view("General", "2")], (t, n) => { if (n === 1) throw new Error("stale ref 47"); return `clicked "${t.label}"`; });
  asks = 0;
  await run({ key: "k", o, surface: "test", driver: f.driver, log: (l) => lines.push(l) });
  assert.deepEqual(f.acts.map((t) => t.ref), ["47", "49"]); assert.equal(f.acts[1], f.seen[1].items[1]); // the fresh read's item
  assert.equal(asks, 3); assert.match(lines.at(-1), /done: 1 action\(s\), 1 stale re-read\(s\)/);
  // perpetual stale: bounded to STALE_REREADS re-reads, never an endless loop
  f = fake([view("Wi-Fi", "47")], () => { throw new Error("stale ref 47"); });
  await assert.rejects(run({ key: "k", o, surface: "test", driver: f.driver, log: () => {} }), /stale re-reads used up after 0 action\(s\), 2 stale/);
  assert.equal(f.acts.length, STALE_REREADS + 1);
  // other driver errors and risky labels never re-read or retry
  f = fake([view("Wi-Fi", "47")], () => { throw new Error("Accessibility is not granted"); });
  await assert.rejects(run({ key: "k", o, surface: "test", driver: f.driver, log: () => {} }), /^Error: Accessibility is not granted$/);
  assert.equal(f.acts.length, 1); assert.equal(f.seen.length, 1);
  f = fake([view("Wi-Fi", "47", "Reset")], () => "pressed");
  await assert.rejects(run({ key: "k", o, surface: "test", driver: f.driver, log: () => {} }), /irreversible/);
  assert.equal(f.acts.length, 0);
  // openaiAsk restricts to the listed keys and normalizes probabilities so validChoice passes
  process.env.DECISION_URL = "http://x/v1";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"choice":"nope","probabilities":{"click_1":3,"done":1}}' } }] }) });
  const got = await openaiAsk("k", { model: "m", state: {}, questions: { action: { type: "choice", criteria: { click_1: "a", done: "b" }, instructions: {} } } });
  assert.equal(got.action.choice, "click_1"); // invented "nope" fell back to the first key
  assert.ok(validChoice(got.action, new Set(["click_1", "done"])));
  assert.ok(Math.abs(got.action.probabilities.click_1 - 0.75) < 0.01);
  delete process.env.DECISION_URL;
  console.log("jev.mjs self-check ok");
}
