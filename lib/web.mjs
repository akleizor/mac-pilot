// web: a browser tab read and driven through JavaScript (`js` in mac.mjs). One call (~0.2 s)
// lists the page's controls in view with refs, labels and window-local centres; actions
// find the control by that ref again, so a removed or relabelled control is "stale".
// The refs are data-mp attributes the read leaves on the elements: stable across reads.

const PRELUDE = `
const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],' +
  '[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]';
const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, 80);
const typing = (el) => { const tag = el.tagName, type = (el.getAttribute("type") || "text").toLowerCase();
  return (tag === "INPUT" && /^(text|search|email|url|tel|password|number)$/.test(type)) || tag === "TEXTAREA"
    || el.isContentEditable || /textbox|combobox/.test(el.getAttribute("role") || ""); };
const labelOf = (el) => clean((el.getAttribute && el.getAttribute("aria-label")) || (el.labels && el.labels[0] && el.labels[0].innerText)
  || el.placeholder || (typing(el) ? "" : el.innerText || el.value) || el.title || el.alt || el.name
  || (el.querySelector && el.querySelector("img[alt]") && el.querySelector("img[alt]").alt));
// window-local centre: the page's viewport sits below the toolbar, centred horizontally
// script-driven controls (a div with a click handler) show a pointer cursor where their parent
// does not; keep is a cheap filter run before the style lookups
const pointer = (el) => getComputedStyle(el).cursor === "pointer" && !(el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer");
const clickables = (keep) => [...document.querySelectorAll("div,span,li,img,svg,td,label,p")].filter((el) => keep(el) && !el.closest(SEL) && pointer(el));
const centre = (r) => ({ x: Math.round(r.left + r.width / 2 + (outerWidth - innerWidth) / 2), y: Math.round(r.top + r.height / 2 + outerHeight - innerHeight) });
`;

// READ returns { title, url, items, context, scroll } as JSON
export const READ = `(() => {${PRELUDE}
  let n = +(document.documentElement.dataset.mpN || 0);
  const items = [];
  const all = [...document.querySelectorAll(SEL), ...clickables((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.top < innerHeight;
  })];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || el.disabled) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
    const t = typing(el), label = labelOf(el), type = (el.getAttribute("type") || "").toLowerCase();
    if (!label && !t) continue;
    if (!el.dataset.mp) el.dataset.mp = String(++n);
    const it = { ref: el.dataset.mp, role: el.getAttribute("role") || (el.tagName === "INPUT" ? type || "text" : el.tagName.toLowerCase()),
      label: label || "(unlabeled field)", kind: t ? "TYPE_TEXT" : "CLICK", ...centre(r) };
    if (t) { const v = el.isContentEditable ? el.innerText : el.value; if (v) it.value = type === "password" ? "•••" : clean(v); }
    if (type === "checkbox" || type === "radio") it.state = el.checked ? "on" : "off";
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) it.selected = true;
    items.push(it);
    if (items.length >= 150) break;
  }
  document.documentElement.dataset.mpN = n;
  const context = [], walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node; (node = walk.nextNode()) && context.length < 60;) {
    const t = clean(node.textContent), p = node.parentElement;
    if (!t || !p || p.closest(SEL) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
    const r = p.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight && r.width > 0) context.push(t);
  }
  const se = document.scrollingElement || document.documentElement;
  return JSON.stringify({ title: document.title, url: location.href, items, context,
    scroll: { y: Math.round(se.scrollTop), max: Math.max(0, se.scrollHeight - innerHeight) } });
})()`;

// act builds the script for one action on ref (or on the page: scroll, enter). It returns
// "stale" when the ref no longer names a control with that label, else a short result.
export function act(op, ref = "", label = "", text = "") {
  return `(() => {${PRELUDE}
  const op = ${JSON.stringify(op)}, label = ${JSON.stringify(label)}, text = ${JSON.stringify(text)};
  if (op === "SCROLL_DOWN" || op === "SCROLL_UP") { scrollBy(0, (op === "SCROLL_DOWN" ? 0.8 : -0.8) * innerHeight); return "scrolled " + (op === "SCROLL_DOWN" ? "down" : "up"); }
  if (op === "SCROLL_BY") { scrollBy(0, +text); return "scrolled " + text + " px"; }
  if (op === "PRESS_ENTER") { const a = document.activeElement || document.body;
    for (const t of ["keydown", "keypress", "keyup"]) a.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    if (a.form) { a.form.requestSubmit(); return "pressed Enter, leaving " + location.href; } return "pressed Enter"; }
  const el = document.querySelector('[data-mp="' + ${JSON.stringify(ref)} + '"]');
  if (!el || !el.isConnected || (label && labelOf(el) !== label && !(typing(el) && label === "(unlabeled field)"))) return "stale";
  el.scrollIntoView({ block: "center", inline: "center" });
  if (op === "LOCATE") return JSON.stringify(centre(el.getBoundingClientRect()));
  if (op === "SHOW") return "scrolled into view";
  if (op === "CLICK") { // a link that opens in this tab: say so, so the caller waits for the new page
    const a = el.closest("a[href]"), h = a && a.getAttribute("href");
    const away = a && !/^(#|javascript:)/i.test(h) && a.target !== "_blank" && a.href.split("#")[0] !== location.href.split("#")[0];
    if (el.tagName === "SELECT") el.focus(); el.click(); return away ? "clicked, leaving " + location.href : "clicked"; }
  if (op === "TYPE_TEXT") {
    el.focus();
    if (el.isContentEditable) { getSelection().selectAllChildren(el); document.execCommand("insertText", false, text); }
    else if (el.tagName === "SELECT") { el.value = text; }
    else { // the native setter, so React-style pages see the change
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "typed";
  }
  return "unknown op " + op;
})()`;
}

// search finds a control by label anywhere on the page, off screen too: exact, then a unique
// substring. It returns the item as JSON, or "none" / "many N".
export function search(spec, kind = "") {
  return `(() => {${PRELUDE}
  const spec = ${JSON.stringify(spec)}, kind = ${JSON.stringify(kind)}, low = spec.toLowerCase();
  const all = [...document.querySelectorAll(SEL), ...clickables((el) => el.getClientRects().length)].filter((el) => !el.disabled && (!kind || (kind === "TYPE_TEXT") === typing(el)) && el.getClientRects().length);
  const lab = all.map((el) => [el, labelOf(el) || (typing(el) ? "(unlabeled field)" : "")]);
  let hits = lab.filter(([, l]) => l === spec);
  if (!hits.length) hits = lab.filter(([, l]) => l.toLowerCase().includes(low));
  if (!hits.length) return "none";
  if (hits.length > 1 && !hits.every(([, l]) => l === hits[0][1])) return "many " + hits.length;
  const [el, label] = hits[0];
  let n = +(document.documentElement.dataset.mpN || 0);
  if (!el.dataset.mp) { el.dataset.mp = String(++n); document.documentElement.dataset.mpN = n; }
  return JSON.stringify({ ref: el.dataset.mp, role: el.getAttribute("role") || el.tagName.toLowerCase(), label, kind: typing(el) ? "TYPE_TEXT" : "CLICK" });
})()`;
}

// find resolves a target among a read's items: @N or a ref, an exact label, then a unique substring.
export function find(items, spec, kind) {
  const pool = kind ? items.filter((it) => it.kind === kind) : items;
  const ref = spec.replace(/^@/, "");
  const hit = pool.find((it) => it.ref === ref && /^@?\d+$/.test(spec))
    || pool.find((it) => it.label === spec)
    || (() => { const m = pool.filter((it) => it.label.toLowerCase().includes(spec.toLowerCase())); return m.length === 1 ? m[0] : undefined; })();
  if (hit) return hit;
  const near = pool.filter((it) => it.label.toLowerCase().includes(spec.toLowerCase())).length;
  throw new Error(near > 1 ? `${spec} matches ${near} controls; use an @N from mac dump` : `nothing matches ${spec} (screen changed?); run mac dump`);
}

if (import.meta.url === `file://${process.argv[1]}`) { // self-check: `node web.mjs`
  const assert = (await import("node:assert")).strict;
  const items = [{ ref: "3", label: "Search", kind: "TYPE_TEXT" }, { ref: "7", label: "Search the web", kind: "CLICK" }, { ref: "9", label: "Sign in", kind: "CLICK" }];
  assert.equal(find(items, "@9").label, "Sign in");
  assert.equal(find(items, "Search").ref, "3"); // exact beats substring
  assert.equal(find(items, "sign").ref, "9");
  assert.equal(find(items, "Search", "CLICK").ref, "7");
  assert.throws(() => find(items, "e"), /matches 2/);
  assert.throws(() => find(items, "@4"), /nothing matches/);
  for (const op of ["CLICK", "TYPE_TEXT", "SCROLL_DOWN", "PRESS_ENTER", "LOCATE"]) new Function(act(op, "1", "a\"b", "it's `x`")); // scripts parse
  new Function(READ); new Function(search("a\"b", "CLICK"));
  console.log("web self-check ok");
}
