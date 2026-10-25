# mac-pilot: lessons for fast, background, universal macOS app control

Context: mac-pilot (github.com/akleizor/mac-pilot) drives macOS apps through the
Accessibility (AX) API: a Swift driver (lib/ax.swift) plus a Node CLI (lib/mac.mjs).
These lessons come from making it work on Electron apps (TradingView, Lark) and on
native apps (System Settings). Check each one on your machine before relying on it.

## 1. Speed: agent turns are the bottleneck, not the driver
- Build the driver once with `swiftc -O` and cache it per source hash. A call then
  takes well under a second. Never run `swift file.swift` per call: it recompiles
  every time, at about 2-3 s each.
- If you keep a long-lived driver process instead (a `serve` mode reading requests
  from a FIFO, one thread per command, a hard timeout per command):
  - `NSWorkspace.frontmostApplication` goes stale unless the run loop turns. Call
    `RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))` before each request.
  - Key the server on a hash of source + settings, and kill older servers when you
    start a new one.
- An agent turn costs 10-30 s; an action costs under 1 s. Chain a whole task, with its
  checks, into one shell call. Sending one chat message step by step took 5 minutes;
  as one call it takes about 10 s.
- A small local decision model picking each step was slower than the agent chaining
  steps itself (12.6 s vs 1.9 s on the same task) and chose wrong paths. Use one only
  for unattended runs.

## 2. Background input: no focus steal, no pointer move
- Native AppKit apps accept AX presses (`AXPress`, set `AXValue`) in the background.
- Chromium/Electron apps ignore AX presses, and drop plain `CGEvent.postToPid` unless
  their window is active. What works is the recipe from open-computer-use's
  `sky_click` / `sky_key` (github.com/iFurySt/open-computer-use, MIT, after Cua and
  yabai). Read its source; you don't need its binary.
  1. Load SkyLight with
     `dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight")`.
     Get the window id with `_AXUIElementGetWindow` and the PSN with `GetProcessForPID`.
  2. Make the app active without raising it. Build a 0xF8-byte record:
     `[4]=0xF8, [8]=0x0D, [0x3C..0x3F]=windowID little-endian, [0x8A]=1`. Post it with
     `SLPSPostEventRecordTo(psn, record)`. When done, post the same record with
     `[0x8A]=2`.
  3. For keys, also make the window key. Post two records with `[8]=1` and `[8]=2`,
     plus `[0x3A]=0x10` and bytes `0x20..0x2F=0xFF`. Wait about 60 ms; at 20 ms the
     first keystroke was dropped. Then post the key events with `postToPid`.
  4. Mouse sequence: moved(target), primer down/up at (-1,-1), then down/up at the
     target. On every event, set these fields with `SLEventSetIntegerValueField`:
     0=phase, 1=clickState, 3=button, 7=3, 40=pid, 51/91/92=windowID,
     58=click-group id. Call `CGEventSetWindowLocation(windowLocalPoint)`. Post through
     both `SLEventPostToPid` and `CGEvent.postToPid`.
  5. Right-click: rightMouseDown/Up with button 1. Double-click: two pairs with
     clickState 1, then 2. Drag: down, about 12 interpolated `leftMouseDragged`
     events, up. Scroll: `CGEvent(scrollWheelEvent2Source:)` with the same fields.
- Occlusion: once macOS marks a Chromium window hidden (covered, or on another Desktop
  since it was last seen), the page stops taking input.
  - While the window is on screen, call
    `SLSPackagesEnableWindowOcclusionNotifications(cid, wid, 0, &prev)`; from then on
    it stays awake when hidden.
  - To reach a window on another Desktop, `SLSManagedDisplaySetCurrentSpace` can flip
    there for about a second and back. The user sees the flip, so get consent first;
    otherwise pin the window whenever it happens to be on screen.
- Screenshot any window, even covered or on another Desktop, with
  `SLSHWCaptureWindowList(cid, &wid, 1, 0x800)`. This needs Screen Recording.
- Verify every step from a fresh dump (a field value, a row status, the window title)
  or from a screenshot. Never trust the command's exit status: a "clicked" report with
  no effect cost the most time here.

## 3. Permissions: macOS checks the "responsible" process
- Accessibility and Screen Recording are checked against the process macOS holds
  responsible, not against your terminal. For example, a tmux server started by a
  LaunchAgent is attributed to that agent's interpreter, so granting the terminal
  doesn't help.
- Find who is blamed with `log show --process tccd`; the `AUTHREQ_ATTRIBUTION` lines
  name it.
- Fix: start the process that runs the driver (e.g. a dedicated `tmux -L helper`
  server) with `posix_spawnattr` + `responsibility_spawnattrs_setdisclaim(attr, 1)`.
  That takes a few lines of Python ctypes. The process is then responsible for itself,
  so grant that binary.
- A background process often can't bring an app forward with
  `NSRunningApplication.activate()`; `open -a APP` works.

## 4. Universal: what reaches which app
- `dump` the window first. Small caps (80 items, 1500 nodes) hide most of a big
  Electron app; about 250 items and 40000 nodes reach deep panels.
- Lists that are only text (a chat list) have no buttons to press. Use the app's own
  search (cmd+k), type, press Return, then verify, e.g. the input field's label.
- Canvases (charts, maps) have no controls. Act at window-local points, then confirm
  the change with a window screenshot.
- Same-label controls (a "Cancel" on every row) follow row order. Before a confirming
  click, check the clicked position against the row's position.
- An `@N` ref must resolve to its own slot. Matching only by label + role failed when
  three buttons shared a label.
- While the screen is locked, the window attributes return the app element. dump still
  reads, but there is no window frame, so mouse input and screenshots fail. Detect
  this instead of chasing a bug.

## 5. Working rules
- Never send, buy, sell, delete or sign out unless the user asked for that exact
  action. Use demo or test accounts for order tests.
- Stop after about 3 failed tries of one approach and report. Silent retrying cost far
  more time than any fix did.
