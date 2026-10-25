// mac-ax: the Accessibility driver behind mac-ops. Each call is one short process:
// it reads the app's window fresh, resolves its target and acts, so no state is kept
// between calls. Presses, value sets and app-targeted key events leave the pointer,
// keyboard focus and front app alone. The Accessibility grant belongs to the app that
// launched it (the terminal or agent app).
import AppKit
import ApplicationServices
import ImageIO

let KIND: [String: String] = [
  "AXButton": "CLICK", "AXCheckBox": "CLICK", "AXRadioButton": "CLICK", "AXPopUpButton": "CLICK",
  "AXMenuButton": "CLICK", "AXLink": "CLICK", "AXMenuItem": "CLICK", "AXDisclosureTriangle": "CLICK",
  "AXRow": "CLICK", "AXTextField": "TYPE_TEXT", "AXTextArea": "TYPE_TEXT", "AXComboBox": "TYPE_TEXT",
]
// 80 items / 1500 nodes hid most of a big Electron app; these reach its deep panels
let MAX_NODES = 40000, MAX_ITEMS = 250
let FIELDS = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled",
              "AXSelected", "AXPlaceholderValue", "AXChildren"]

struct Item: Codable {
  var ref: String, role: String, label: String, kind: String
  var value: String? = nil, state: String? = nil, selected: Bool? = nil
}
struct Dump: Codable { var app: String, window: String, items: [Item], context: [String], locked: Bool? = nil }

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

// dialogs such as SecurityAgent's password prompt have no focused or main window
func window(_ root: AXUIElement) -> AXUIElement? {
  element(attr(root, "AXFocusedWindow")) ?? element(attr(root, "AXMainWindow"))
    ?? (attr(root, "AXWindows") as? [AXUIElement])?.first
}

func read(_ name: String) -> (NSRunningApplication, Dump, [AXUIElement], AXUIElement) {
  let (app, root) = appRoot(name)
  guard let win = window(root) else { fail("\(app.localizedName ?? name) has no window") }
  if sky(app), let wid = windowID(win) { keepAwake(wid) }
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
  // while the screen is locked the window attributes return the app element: reads work, mouse input does not
  let locked = clean(attr(win, "AXRole")) == "AXApplication" || screenLocked()
  return (app, Dump(app: app.localizedName ?? name, window: clean(attr(win, "AXTitle")), items: items, context: context,
                    locked: locked ? true : nil), els, win)
}

// target resolves a label (exact, then unique substring) among controls of `kind`,
// or the @N of the last dump, given as the label and role it had then (`was`),
// against this fresh read: gone or ambiguous is refused, never guessed.
func target(_ d: Dump, _ spec: String, kind: String, was: (String, String)?) -> Item {
  let match: (Item) -> Bool
  var pool = d.items
  if let (label, role) = was { // @N is its own slot: matching label + role alone failed when three buttons shared a label
    guard let n = Int(spec.dropFirst()), n >= 1, n <= d.items.count, d.items[n - 1].label == label, d.items[n - 1].role == role
    else { fail("\(spec) no longer names \"\(label)\" [\(role)] (screen changed?); run mac dump") }
    return d.items[n - 1]
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

// ---------- background input for Chromium/Electron (private SkyLight) ----------
// Chromium ignores AX presses and drops app-targeted events unless its window is active.
// The recipe is open-computer-use's sky_click/sky_key (github.com/iFurySt/open-computer-use,
// MIT, Copyright (c) 2026 Leo; after Cua and yabai): make the app active without raising it, stamp the window into
// every event, post through SkyLight and the public path. A missing symbol fails the call.
let SKYLIGHT = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
let APPSVC = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)
func sym<T>(_ lib: UnsafeMutableRawPointer?, _ name: String, _: T.Type) -> T? {
  guard let lib, let p = dlsym(lib, name) else { return nil }
  return unsafeBitCast(p, to: T.self)
}
let slPostToPid = sym(SKYLIGHT, "SLEventPostToPid", (@convention(c) (pid_t, UnsafeMutableRawPointer?) -> Void).self)
let slSetField = sym(SKYLIGHT, "SLEventSetIntegerValueField", (@convention(c) (UnsafeMutableRawPointer?, UInt32, Int64) -> Void).self)
let slSetWindowLocation = sym(SKYLIGHT, "CGEventSetWindowLocation", (@convention(c) (UnsafeMutableRawPointer?, Double, Double) -> Void).self)
let slPostRecord = sym(SKYLIGHT, "SLPSPostEventRecordTo", (@convention(c) (UnsafeRawPointer?, UnsafePointer<UInt8>?) -> Int32).self)
let slConnection = sym(SKYLIGHT, "SLSMainConnectionID", (@convention(c) () -> UInt32).self)
let slOcclusion = sym(SKYLIGHT, "SLSPackagesEnableWindowOcclusionNotifications", (@convention(c) (UInt32, CGWindowID, UInt8, UnsafeMutablePointer<UInt8>?) -> Int32).self)
let slCapture = sym(SKYLIGHT, "SLSHWCaptureWindowList", (@convention(c) (UInt32, UnsafePointer<CGWindowID>, Int32, UInt32) -> Unmanaged<CFArray>?).self)
let getPSN = sym(APPSVC, "GetProcessForPID", (@convention(c) (pid_t, UnsafeMutableRawPointer?) -> Int32).self)
let axWindowID = sym(APPSVC, "_AXUIElementGetWindow", (@convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError).self)

// sky: the app is built on Chromium (Electron, CEF, Chrome), so it needs the SkyLight path
func sky(_ app: NSRunningApplication) -> Bool {
  guard let dir = app.bundleURL?.appendingPathComponent("Contents/Frameworks").path,
        let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return false }
  return names.contains { $0.hasPrefix("Electron Framework") || $0.hasPrefix("Chromium Embedded Framework")
    || ($0.hasSuffix(" Framework.framework") && ($0.contains("Chrome") || $0.contains("Chromium"))) }
}

// inWeb: the control sits in a web area, where an AX press is often ignored
func inWeb(_ el: AXUIElement) -> Bool {
  var cur: AXUIElement? = el
  for _ in 0..<40 {
    guard let c = cur else { return false }
    if clean(attr(c, "AXRole")) == "AXWebArea" { return true }
    cur = element(attr(c, "AXParent"))
  }
  return false
}

func screenLocked() -> Bool {
  ((CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool) == true
}

func windowID(_ win: AXUIElement) -> CGWindowID? {
  var wid: CGWindowID = 0
  guard let axWindowID, axWindowID(win, &wid) == .success, wid != 0 else { return nil }
  return wid
}

func frame(_ el: AXUIElement) -> CGRect? {
  var p = CGPoint.zero, s = CGSize.zero
  guard let pv = attr(el, "AXPosition"), let sv = attr(el, "AXSize"),
        AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s) else { return nil }
  return CGRect(origin: p, size: s)
}

// keepAwake: once macOS marks a Chromium window hidden (covered, or on another Desktop) the
// page stops taking input. Turning off its occlusion notifications while it is on screen
// pins it awake from then on; called while hidden it would pin it asleep, so it waits.
func keepAwake(_ wid: CGWindowID) {
  guard let slConnection, let slOcclusion,
        let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, wid) as? [[String: Any]])?.first,
        (info[kCGWindowIsOnscreen as String] as? Bool) == true else { return }
  var prev: UInt8 = 0
  _ = slOcclusion(slConnection(), wid, 0, &prev)
}

func usable(_ app: NSRunningApplication) {
  if screenLocked() { fail("the screen is locked: reads still work, but mouse input and screenshots cannot") }
  if app.isHidden { fail("\(app.localizedName ?? "app") is hidden; unhide it first") }
  guard slPostToPid != nil, slSetField != nil, slSetWindowLocation != nil, slPostRecord != nil, getPSN != nil
  else { fail("this macOS lacks the SkyLight functions background input needs") }
}

func record(_ wid: CGWindowID, _ bytes: [Int: UInt8]) -> [UInt8] {
  var r = [UInt8](repeating: 0, count: 0xF8)
  r[0x04] = 0xF8
  for i in 0..<4 { r[0x3C + i] = UInt8(truncatingIfNeeded: wid >> (8 * UInt32(i))) } // window id, little-endian
  for (i, v) in bytes { r[i] = v }
  return r
}

// activeWhile runs body with the app active (and for keys its window key) without raising it.
func activeWhile(_ app: NSRunningApplication, _ wid: CGWindowID, keys: Bool, _ body: () -> Void) {
  usable(app)
  let pid = app.processIdentifier
  if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { body(); return }
  var psn = [UInt8](repeating: 0, count: 8)
  guard psn.withUnsafeMutableBytes({ getPSN!(pid, $0.baseAddress) }) == 0 else { fail("no process serial number for \(pid)") }
  let post = { (r: [UInt8]) in _ = psn.withUnsafeBytes { p in r.withUnsafeBufferPointer { slPostRecord!(p.baseAddress, $0.baseAddress) } } }
  post(record(wid, [0x08: 0x0D, 0x8A: 1]))
  usleep(10_000)
  if keys {
    var r = record(wid, [0x3A: 0x10])
    for i in 0x20..<0x30 { r[i] = 0xFF }
    for kind: UInt8 in [1, 2] { r[0x08] = kind; post(r) }
    usleep(60_000) // at 20 ms the first keystroke was dropped
  }
  body()
  usleep(100_000) // Chromium's renderer takes the last event before the app goes inactive
  post(record(wid, [0x08: 0x0D, 0x8A: 2]))
}

// skyClick clicks at a window-local point: moved(target), a primer down/up at (-1,-1),
// then down/up at the target, each stamped with the window and posted both ways.
func skyClick(_ app: NSRunningApplication, _ win: AXUIElement, at local: CGPoint) {
  guard let wid = windowID(win), let wf = frame(win) else { fail("no window frame (screen locked?)") }
  guard local.x >= 0, local.y >= 0, local.x < wf.width, local.y < wf.height
  else { fail("\(Int(local.x)),\(Int(local.y)) is outside the \(Int(wf.width))x\(Int(wf.height)) window") }
  let pid = app.processIdentifier, src = CGEventSource(stateID: .hidSystemState)
  let group = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)
  let steps: [(CGEventType, Bool, Int64, Int64, useconds_t)] = [ // type, at target, clickState, phase, wait
    (.mouseMoved, true, 0, 2, 15_000), (.leftMouseDown, false, 1, 1, 1_000), (.leftMouseUp, false, 1, 2, 100_000),
    (.leftMouseDown, true, 1, 3, 1_000), (.leftMouseUp, true, 1, 3, 0),
  ]
  activeWhile(app, wid, keys: false) {
    for (type, atTarget, clicks, phase, wait) in steps {
      let w = atTarget ? local : CGPoint(x: -1, y: -1)
      let screen = atTarget ? CGPoint(x: wf.minX + local.x, y: wf.minY + local.y) : w
      let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: screen, mouseButton: .left)!
      let ref = Unmanaged.passUnretained(e).toOpaque()
      let fields: [(UInt32, Int64)] = [(0, phase), (1, clicks), (3, 0), (7, 3), (40, Int64(pid)),
                                       (51, Int64(wid)), (58, group), (91, Int64(wid)), (92, Int64(wid))]
      for (f, v) in fields { slSetField!(ref, f, v) }
      slSetWindowLocation!(ref, w.x, w.y)
      slPostToPid!(pid, ref)
      e.postToPid(pid)
      usleep(wait)
    }
  }
}

// toApp delivers app-targeted keys; a Chromium app drops them unless its window is active and key.
func toApp(_ app: NSRunningApplication, _ body: () -> Void) {
  guard sky(app) else { return body() }
  let root = AXUIElementCreateApplication(app.processIdentifier)
  guard let win = window(root), let wid = windowID(win) else { fail("\(app.localizedName ?? "app") has no window for keys") }
  activeWhile(app, wid, keys: true, body)
}

// shortcut presses the menu item bound to a cmd combo: a background Chromium app drops
// synthetic cmd keys, but its menu bar still takes an AX press.
func shortcut(_ app: NSRunningApplication, _ combo: String) -> Bool {
  let parts = combo.lowercased().split(separator: "+").map(String.init)
  guard parts.contains(where: { MODS[$0] == .maskCommand }), let key = parts.last, key.count == 1 else { return false }
  var want = 0 // AXMenuItemCmdModifiers: shift 1, option 2, control 4 (cmd implied)
  for p in parts { switch MODS[p] { case .maskShift?: want |= 1; case .maskAlternate?: want |= 2; case .maskControl?: want |= 4; default: break } }
  func find(_ el: AXUIElement, _ depth: Int) -> AXUIElement? {
    if depth > 6 { return nil }
    for c in children(el) {
      if clean(attr(c, "AXRole")) == "AXMenuItem", (attr(c, "AXEnabled") as? Bool) != false,
         clean(attr(c, "AXMenuItemCmdChar")).lowercased() == key,
         ((attr(c, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0) == want { return c }
      if let hit = find(c, depth + 1) { return hit }
    }
    return nil
  }
  guard let bar = element(attr(AXUIElementCreateApplication(app.processIdentifier), "AXMenuBar")),
        let item = find(bar, 0) else { return false }
  return AXUIElementPerformAction(item, "AXPress" as CFString) == .success
}

// shot captures one window's backing store, even covered or on another Desktop (needs Screen Recording).
func shot(_ app: NSRunningApplication, _ win: AXUIElement, _ path: String) {
  if screenLocked() { fail("the screen is locked: screenshots cannot work") }
  guard var wid = windowID(win), let slConnection, let slCapture else { fail("window capture is unavailable") }
  guard let arr = slCapture(slConnection(), &wid, 1, 0x800)?.takeRetainedValue(), CFArrayGetCount(arr) > 0
  else { fail("capture returned nothing: grant Screen Recording to the app running mac") }
  let img = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CGImage.self)
  guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)
  else { fail("cannot write \(path)") }
  CGImageDestinationAddImage(dest, img, nil)
  guard CGImageDestinationFinalize(dest) else { fail("cannot write \(path)") }
  print("saved \(img.width)x\(img.height) \(path)")
}

// ---------- actions ----------
// press clicks a control: an AX press for native controls, the SkyLight click at its centre for Chromium ones.
func press(_ app: NSRunningApplication, _ win: AXUIElement, _ el: AXUIElement) {
  if sky(app) || inWeb(el) {
    guard let f = frame(el), let wf = frame(win) else { fail("the control has no frame (screen locked?)") }
    return skyClick(app, win, at: CGPoint(x: f.midX - wf.minX, y: f.midY - wf.minY))
  }
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
let at = take("--at").flatMap { v -> CGPoint? in
  let n = v[0].split(separator: ",").compactMap { Double($0) }
  return n.count == 2 ? CGPoint(x: n[0], y: n[1]) : nil
}
let keys = args.contains("--keys")
args.removeAll { $0 == "--keys" }

switch (cmd, args.count) {
case ("apps", _): apps()
case ("dump", 1):
  let (_, d, _, _) = read(args[0])
  print(String(data: try! JSONEncoder().encode(d), encoding: .utf8)!)
case ("click", 1): // canvases (charts, maps) have no controls: a window-local point, then confirm with shot
  guard let at else { fail("click needs a target, or --at X,Y (window-local points)") }
  let (app, root) = appRoot(args[0])
  guard let win = window(root) else { fail("\(args[0]) has no window") }
  skyClick(app, win, at: at)
  print("clicked at \(Int(at.x)),\(Int(at.y))")
case ("shot", 2):
  let (app, root) = appRoot(args[0])
  guard let win = window(root) else { fail("\(args[0]) has no window") }
  shot(app, win, args[1])
case ("click", 2):
  let (app, d, els, win) = read(args[0])
  let it = target(d, args[1], kind: "CLICK", was: was)
  press(app, win, els[Int(it.ref)! - 1])
  print("clicked \(it.role) \"\(it.label)\"")
case ("type", 2): // the text arrives on stdin, never on a command line
  let (app, d, els, _) = read(args[0])
  let it = target(d, args[1], kind: "TYPE_TEXT", was: was)
  let el = els[Int(it.ref)! - 1], text = stdinText()
  if keys {
    // Apple's sign-in sheets are drawn by another process and ignore an AX value and
    // app-targeted keys; global keys go wherever focus is, so the app must be in front.
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
    else { fail("\(args[0]) is not in front; keys not sent") }
    _ = setValue(el, "")
    typeText(text, pid: nil)
  } else if !setValue(el, text) { toApp(app) { typeText(text, pid: app.processIdentifier) } } // some web views refuse a value
  print("typed into \(it.role) \"\(it.label)\"")
case ("act", 3): // flow: act APP REF OP --was LABEL ROLE; the ref must still name the same control
  let (app, d, els, win) = read(args[0])
  if args[2] == "PRESS_ENTER" { toApp(app) { _ = keyStroke("return", pid: app.processIdentifier) }; print("ok"); exit(0) }
  guard let n = Int(args[1]), n >= 1, n <= d.items.count, let (label, role) = was,
        d.items[n - 1].label == label, d.items[n - 1].role == role
  else { fail("stale ref \(args[1])") }
  if args[2] == "TYPE_TEXT" {
    let text = stdinText()
    if !setValue(els[n - 1], text) { toApp(app) { typeText(text, pid: app.processIdentifier) } }
  } else { press(app, win, els[n - 1]) }
  print("ok")
case ("key", 2):
  let (app, _) = appRoot(args[0])
  var known = true
  if !(sky(app) && shortcut(app, args[1])) { toApp(app) { known = keyStroke(args[1], pid: app.processIdentifier) } }
  guard known else { fail("unknown key in \(args[1])") }
  print("pressed \(args[1])")
case ("menu", 2): menu(args[0], args[1])
default:
  fail("usage: mac-ax dump|click|type|act|key|menu|shot APP ... | apps | running APP | front | trusted [--prompt]")
}
