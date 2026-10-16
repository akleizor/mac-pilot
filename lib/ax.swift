// mac-ax: the Accessibility driver behind mac-ops. Each call is one short process:
// it reads the app's window fresh, resolves its target and acts, so no state is kept
// between calls. Presses, value sets and app-targeted key events leave the pointer,
// keyboard focus and front app alone. The Accessibility grant belongs to the app that
// launched it (the terminal or agent app).
import AppKit
import ApplicationServices

let KIND: [String: String] = [
  "AXButton": "CLICK", "AXCheckBox": "CLICK", "AXRadioButton": "CLICK", "AXPopUpButton": "CLICK",
  "AXMenuButton": "CLICK", "AXLink": "CLICK", "AXMenuItem": "CLICK", "AXDisclosureTriangle": "CLICK",
  "AXRow": "CLICK", "AXTextField": "TYPE_TEXT", "AXTextArea": "TYPE_TEXT", "AXComboBox": "TYPE_TEXT",
]
let MAX_NODES = 1500, MAX_ITEMS = 80
let FIELDS = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled",
              "AXSelected", "AXPlaceholderValue", "AXChildren"]

struct Item: Codable {
  var ref: String, role: String, label: String, kind: String
  var value: String? = nil, state: String? = nil, selected: Bool? = nil
}
struct Dump: Codable { var app: String, window: String, items: [Item], context: [String] }

func fail(_ msg: String) -> Never { print(msg); exit(1) }

func clean(_ v: AnyObject?) -> String {
  guard let s = v as? String else { return "" }
  return s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func element(_ v: AnyObject?) -> AXUIElement? {
  guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

// One round trip for every field a node needs; a missing attribute comes back as an AXError value.
func attrs(_ el: AXUIElement) -> [String: AnyObject] {
  var out: CFArray?
  guard AXUIElementCopyMultipleAttributeValues(el, FIELDS as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
        let values = out as? [AnyObject] else { return [:] }
  var d: [String: AnyObject] = [:]
  for (name, v) in zip(FIELDS, values) {
    if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
    d[name] = v
  }
  return d
}

func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, "AXChildren") as? [AXUIElement]) ?? [] }

// text of descendants: the label of an unlabeled row or button
func innerText(_ el: AXUIElement, _ depth: Int) -> String {
  if depth > 4 { return "" }
  let parts = children(el).map { c -> String in
    clean(attr(c, "AXRole")) == "AXStaticText" ? clean(attr(c, "AXValue")) : innerText(c, depth + 1)
  }.filter { !$0.isEmpty }
  return String(parts.joined(separator: " ").prefix(80))
}

// exact name or bundle id only: a looser match once resolved "System Settings" to another app
func findApp(_ name: String) -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first { $0.localizedName == name || $0.bundleIdentifier == name }
}

func appRoot(_ name: String) -> (NSRunningApplication, AXUIElement) {
  guard let app = findApp(name) else { fail("no running app named \(name)") }
  let root = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(root, 3)
  return (app, root)
}

func read(_ name: String) -> (NSRunningApplication, Dump, [AXUIElement]) {
  let (app, root) = appRoot(name)
  // dialogs such as SecurityAgent's password prompt have no focused or main window
  guard let win = element(attr(root, "AXFocusedWindow")) ?? element(attr(root, "AXMainWindow"))
          ?? (attr(root, "AXWindows") as? [AXUIElement])?.first
  else { fail("\(app.localizedName ?? name) has no window") }
  var items: [Item] = [], els: [AXUIElement] = [], context: [String] = [], seen = 0
  func walk(_ el: AXUIElement, _ depth: Int) {
    seen += 1
    if seen > MAX_NODES || depth > 40 || items.count >= MAX_ITEMS { return }
    let a = attrs(el)
    let role = clean(a["AXRole"])
    if role == "AXStaticText", context.count < 60 {
      let t = clean(a["AXValue"])
      if !t.isEmpty { context.append(t) }
    }
    if let kind = KIND[role], (a["AXEnabled"] as? Bool) != false {
      var label = clean(a["AXTitle"]).isEmpty ? clean(a["AXDescription"]) : clean(a["AXTitle"])
      if kind == "TYPE_TEXT", label.isEmpty { label = clean(a["AXPlaceholderValue"]) }
      if label.isEmpty { label = innerText(el, 0) }
      if !label.isEmpty || kind == "TYPE_TEXT" {
        els.append(el)
        let sub = clean(a["AXSubrole"])
        var it = Item(ref: String(els.count), role: String((sub.isEmpty ? role : sub).dropFirst(2)),
                      label: label.isEmpty ? "(unlabeled field)" : label, kind: kind)
        let value = clean(a["AXValue"])
        if kind == "TYPE_TEXT", !value.isEmpty { it.value = String(value.prefix(80)) }
        if role == "AXCheckBox" { it.state = (a["AXValue"] as? NSNumber)?.intValue == 1 ? "on" : "off" }
        if (a["AXSelected"] as? Bool) == true { it.selected = true }
        items.append(it)
        if role == "AXRow" || role == "AXButton" { return } // a row's children repeat its label
      }
    }
    for c in (a["AXChildren"] as? [AXUIElement]) ?? [] { walk(c, depth + 1) }
  }
  walk(win, 0)
  return (app, Dump(app: app.localizedName ?? name, window: clean(attr(win, "AXTitle")), items: items, context: context), els)
}

// target resolves a label (exact, then unique substring) among controls of `kind`,
// or the @N of the last dump, given as the label and role it had then (`was`),
// against this fresh read: gone or ambiguous is refused, never guessed.
func target(_ d: Dump, _ spec: String, kind: String, was: (String, String)?) -> Item {
  var match: (Item) -> Bool
  var pool = d.items
  if let (label, role) = was {
    match = { $0.label == label && $0.role == role }
  } else {
    pool = pool.filter { $0.kind == kind }
    let exact = pool.filter { $0.label == spec }
    if exact.count == 1 { return exact[0] }
    let low = spec.lowercased()
    match = exact.count > 1 ? { $0.label == spec } : { $0.label.lowercased().contains(low) }
  }
  let hits = pool.filter(match)
  if hits.count == 1 { return hits[0] }
  if hits.isEmpty { fail("nothing matches \(spec) (screen changed?); run mac-ops dump") }
  let names = hits.prefix(6).map { "\"\($0.label)\" [\($0.role)]" }.joined(separator: ", ")
  fail("\(spec) matches \(hits.count): \(names); run mac-ops dump and use its @N")
}

// ---------- keyboard ----------
let KEYCODES: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
  "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
  ".": 47, "`": 50, "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
  "esc": 53, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "left": 123, "right": 124, "down": 125, "up": 126, "f1": 122, "f2": 120, "f3": 99, "f4": 118,
  "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
let MODS: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "shift": .maskShift, "alt": .maskAlternate,
  "option": .maskAlternate, "opt": .maskAlternate, "ctrl": .maskControl, "control": .maskControl,
  "fn": .maskSecondaryFn,
]

func keyStroke(_ combo: String, pid: pid_t) -> Bool {
  var flags = CGEventFlags(), code: CGKeyCode?
  for part in combo.lowercased().split(separator: "+").map(String.init) {
    if let m = MODS[part] { flags.insert(m) } else { code = KEYCODES[part] }
  }
  guard let code else { return false }
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
    e.flags = flags
    e.postToPid(pid)
  }
  return true
}

// typeText posts the text as Unicode key events: to one app, or globally (pid nil),
// where they go to whatever has keyboard focus.
func typeText(_ text: String, pid: pid_t?) {
  for ch in text {
    let units = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)!
      e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      if let pid { e.postToPid(pid) } else { e.post(tap: .cghidEventTap) }
    }
    usleep(4000)
  }
}

// ---------- actions ----------
func press(_ el: AXUIElement) {
  var names: CFArray?
  AXUIElementCopyActionNames(el, &names)
  if ((names as? [String]) ?? []).contains("AXPress") { AXUIElementPerformAction(el, "AXPress" as CFString) }
  else { AXUIElementSetAttributeValue(el, "AXSelected" as CFString, kCFBooleanTrue) } // sidebar and list rows select
}

func setValue(_ el: AXUIElement, _ text: String) -> Bool {
  AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
  return AXUIElementSetAttributeValue(el, "AXValue" as CFString, text as CFString) == .success
}

func menu(_ name: String, _ path: String) {
  let (_, root) = appRoot(name)
  guard var cur = element(attr(root, "AXMenuBar")) else { fail("\(name) has no menu bar") }
  for part in path.split(separator: ">").map({ $0.trimmingCharacters(in: .whitespaces) }) {
    var kids = children(cur)
    if clean(attr(cur, "AXRole")) != "AXMenuBar" { // an item's entries sit in its AXMenu child
      kids = kids.first { clean(attr($0, "AXRole")) == "AXMenu" }.map(children) ?? []
    }
    guard let next = kids.first(where: { clean(attr($0, "AXTitle")) == part }) else { fail("no enabled menu item \(path)") }
    cur = next
  }
  if (attr(cur, "AXEnabled") as? Bool) == false { fail("no enabled menu item \(path)") }
  AXUIElementPerformAction(cur, "AXPress" as CFString)
  print("chose \(path)")
}

// apps lists running apps that have a window, so a dialog's owner
// (SecurityAgent, UserNotificationCenter, coreautha) can be found by name.
func apps() {
  var rows: [String] = []
  for app in NSWorkspace.shared.runningApplications {
    let el = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(el, 0.3) // one hung app must not stall the whole list
    guard let wins = attr(el, "AXWindows") as? [AXUIElement], !wins.isEmpty else { continue }
    let titles = wins.prefix(3).map { clean(attr($0, "AXTitle")) }.joined(separator: " / ")
    rows.append("\(app.localizedName ?? "-") | \(app.bundleIdentifier ?? "-") | \(titles)")
  }
  print(rows.sorted().joined(separator: "\n"))
}

// ---------- command line ----------
var args = Array(CommandLine.arguments.dropFirst())
func take(_ flag: String, count: Int = 1) -> [String]? {
  guard let i = args.firstIndex(of: flag), i + count < args.count else { return nil }
  let v = Array(args[(i + 1)...(i + count)])
  args.removeSubrange(i...(i + count))
  return v
}
func stdinText() -> String { String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "" }

// a busy app answers within 3 s or the call fails, instead of blocking for the system default
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 3)
let cmd = args.isEmpty ? "" : args.removeFirst()
if cmd == "trusted" {
  let prompt = args.contains("--prompt")
  print(AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": prompt] as CFDictionary) ? "granted" : "not granted")
  exit(0)
}
if cmd == "running" { print(args.first.flatMap(findApp) == nil ? "down" : "up"); exit(0) }
if cmd == "front" { print(NSWorkspace.shared.frontmostApplication?.localizedName ?? ""); exit(0) }
if !AXIsProcessTrusted() {
  fail("Accessibility is not granted to the app running mac-ops; run mac-ops setup")
}
let was = take("--was", count: 2).map { ($0[0], $0[1]) }
let keys = args.contains("--keys")
args.removeAll { $0 == "--keys" }

switch (cmd, args.count) {
case ("apps", _): apps()
case ("dump", 1):
  let (_, d, _) = read(args[0])
  print(String(data: try! JSONEncoder().encode(d), encoding: .utf8)!)
case ("click", 2):
  let (_, d, els) = read(args[0])
  let it = target(d, args[1], kind: "CLICK", was: was)
  press(els[Int(it.ref)! - 1])
  print("clicked \(it.role) \"\(it.label)\"")
case ("type", 2): // the text arrives on stdin, never on a command line
  let (app, d, els) = read(args[0])
  let it = target(d, args[1], kind: "TYPE_TEXT", was: was)
  let el = els[Int(it.ref)! - 1], text = stdinText()
  if keys {
    // Apple's sign-in sheets are drawn by another process and ignore an AX value and
    // app-targeted keys; global keys go wherever focus is, so the app must be in front.
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
    else { fail("\(args[0]) is not in front; keys not sent") }
    _ = setValue(el, "")
    typeText(text, pid: nil)
  } else if !setValue(el, text) { typeText(text, pid: app.processIdentifier) } // some web views refuse a value
  print("typed into \(it.role) \"\(it.label)\"")
case ("act", 3): // flow: act APP REF OP --was LABEL ROLE; the ref must still name the same control
  let (app, d, els) = read(args[0])
  if args[2] == "PRESS_ENTER" { _ = keyStroke("return", pid: app.processIdentifier); print("ok"); exit(0) }
  guard let n = Int(args[1]), n >= 1, n <= d.items.count, let (label, role) = was,
        d.items[n - 1].label == label, d.items[n - 1].role == role
  else { fail("stale ref \(args[1])") }
  if args[2] == "TYPE_TEXT" {
    let text = stdinText()
    if !setValue(els[n - 1], text) { typeText(text, pid: app.processIdentifier) }
  } else { press(els[n - 1]) }
  print("ok")
case ("key", 2):
  let (app, _) = appRoot(args[0])
  guard keyStroke(args[1], pid: app.processIdentifier) else { fail("unknown key in \(args[1])") }
  print("pressed \(args[1])")
case ("menu", 2): menu(args[0], args[1])
default:
  fail("usage: mac-ax dump|click|type|act|key|menu APP ... | apps | running APP | front | trusted [--prompt]")
}
