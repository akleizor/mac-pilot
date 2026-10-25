---
name: mac-pilot
description: "Operate macOS apps the way a person would, without screenshots and without taking the user's pointer or focus: click buttons, choose menus, fill fields, press keys, answer password and permission dialogs. `mac flow` runs a routine flow in one call (Jev picks each step); dump, click, type, key, menu cover everything else. Use for any desktop app or system dialog ('open Displays settings', 'configure X in app Y', 'approve the admin password prompt'). Electron/Chromium apps (TradingView, Lark, VS Code, Discord) work in the background too, and canvases take window-local clicks checked with `shot`. Not for websites or phones."
---

# mac-pilot

`M=<this skill folder>/bin/mac`. Every command takes `--app NAME` (exact app name or
bundle id); `$M apps` lists the apps that have a window.

| Command | Does |
|---|---|
| `flow "GOAL"` | A routine flow; Jev picks each step (2–4 s) |
| `plan FILE` | A JSON plan: deterministic steps, checked postconditions, one bounded recovery |
| `dump` | Controls as `@N [Role] "label" = value (state)`, then the window's text |
| `click <@N\|label>` | Press a control, or select a list or sidebar row |
| `click --at X,Y` | Click a window-local point (canvases: charts, maps); `--right` / `--double` work on any click |
| `drag --at X,Y --to X,Y` | Drag between window-local points |
| `scroll <up\|down\|left\|right> [@N\|label]` | Scroll the window (`--lines N`, default 5; `--at X,Y`), or bring a control into view |
| `shot FILE.png` | Screenshot the window, even covered or on another Desktop (Screen Recording) |
| `type <@N\|label> TEXT` | Set a field; `--secret ENVVAR` reads the text from the environment; `--keys` types real keystrokes |
| `key <combo>` | `return`, `escape`, `tab`, `cmd+a`, `cmd+shift+n` … sent to that app |
| `menu "File > New"` | Choose a menu-bar item |
| `open` · `apps` | Launch in the background · list apps with a window |
| `setup` | Build the driver, ask for Accessibility once, check the decision model |

```bash
$M flow "Open General, then its About page" --app "System Settings"
$M dump --app "System Settings" && $M click --app "System Settings" Bluetooth
$M type --app "System Settings" Search "Night Shift"
```

- **`type --keys`** sends real keystrokes instead of setting the value. Some
  sign-in sheets are drawn by another process: they show an accessibility value
  but never submit it, and ignore keys aimed at the host app. `--keys` types
  globally, so it refuses unless the app is in front; bring the app forward first.
- **Chain the whole task in one shell call**, checks included (`&&`). An agent
  turn costs 10–30 s and an action under 1 s: one chat message sent step by step
  took 5 minutes, as one call about 10 s.
- **Verify every step** from a fresh `dump` (a field value, a row status, the
  window title) or a `shot`. Never trust an exit status: a "clicked" with no
  effect cost the most time.
- **Targets.** A label matches exactly, then by unique substring, among the
  controls the command acts on (fields for `type`). `@N` is the Nth control of the
  last `dump`, and a fresh read must still show the same label and role in that
  slot, or it is refused. Same-label controls (a "Cancel" on every row) follow row
  order: before a confirming click, check the `@N` sits on the row you mean.
- **Nothing moves.** Presses, value sets and app-targeted keys leave the pointer,
  focus and front app alone. Exception: a menu item that opens a window can bring
  its app forward (Finder "New Finder Window" did).
- **Never take the user's front.** Do not activate, raise or `open -a` an app,
  and do not use screenshot-and-click computer use on an app `mac` can reach:
  every gesture here works with the app behind other windows. Bring an app
  forward only when the user asks for it.
- **Chromium and Electron apps** ignore AX presses and drop keys unless active.
  `mac` detects them (and any control inside a web area) and clicks the
  control's centre through SkyLight instead, marking the app active without
  raising it; keys go the same way, and cmd shortcuts press their menu item. Each
  read also keeps an on-screen Chromium window awake, so it still takes input
  once covered; a window that was hidden before `mac` first saw it must come on
  screen once (flipping Desktops shows on screen: ask first).
- **Scrolling a Chromium app** in the background goes by arrow keys (its page
  ignores synthetic wheel events unless in front), so it scrolls whatever has
  focus: after `type` into a field, the arrows move the caret instead. `scroll
  down @N` brings that control into view by an AX action, on any app.
- **Launching never keeps the front.** Most apps take the front when their first
  window opens, `open -g` or not; `mac` watches for 1.5 s and hands it straight
  back to the app you were in. Prefer driving apps that are already running.
- **Text-only lists** (a chat list) have no buttons. Use the app's own search
  (`key cmd+k`), type, `key return`, then verify, e.g. by the input field's label.
- **Canvases** (charts, maps) have no controls: `click --at X,Y` (window-local
  points), then confirm with `shot`.
- **Password prompts.** An admin dialog belongs to `SecurityAgent`, a permission
  alert to `UserNotificationCenter` or the requesting app; find the owner with
  `$M apps`, then fill its field and press the button:
  ```bash
  PW="$(your-password-tool)" $M type --app SecurityAgent Password --secret PW \
    && $M click --app SecurityAgent "Allow Access"
  ```
- **Privacy switches** in System Settings (Privacy & Security → Automation and
  the like) do not flip from an accessibility press: macOS guards them. Answer
  the permission prompt when it appears instead.
- **Locked screen.** Apps keep running and `mac` still reads them while
  locked (`dump` says so); mouse input (`--at`, Chromium clicks) and `shot`
  refuse, since the window has no frame. The lock screen is the `loginwindow` app; unlock it with the same
  password, only after confirming the lock so the password can never land in an
  app:
  ```bash
  locked() { ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked raw - 2>/dev/null || echo false; }
  [ "$(locked)" = true ] && PW="$(your-password-tool)" \
    $M type --app loginwindow "Enter Password" --secret PW && $M key --app loginwindow return
  ```

- **Permissions follow the responsible process**, not your terminal: a tmux
  server started by a LaunchAgent is charged to that agent's interpreter. Find
  who is blamed with `log show --process tccd` (`AUTHREQ_ATTRIBUTION` lines);
  start the runner with `responsibility_spawnattrs_setdisclaim(attr, 1)` so it is
  responsible for itself, and grant that binary.
- **Working rules.** Never send, buy, sell, delete or sign out unless asked for
  that exact action; test orders on demo accounts. Stop after about 3 failed
  tries of one approach and report.

## Plans: deterministic steps with a checkpoint

`$M plan FILE --app NAME` (a path or `-` for stdin) runs a JSON plan: steps are
pressed deterministically, each with the postcondition it must leave on screen,
and the whole plan is validated before the first press.

```json
{
  "goal": "Open General, then its About page",
  "steps": [
    { "click": "General", "post": [{ "window": "General" }] },
    { "click": "About",   "post": [{ "window": "About" }] }
  ],
  "success": [ { "window": "About" }, { "exists": "macOS" } ],
  "recovery": 1
}
```

- **Steps** are `{"click": label}` or `{"type": label, "text": "..."}`, plus
  `post`: what the window must show once the step has acted. There are no key
  steps: `return`, `space` or `cmd+delete` press whatever is default or focused,
  which no label check can see, so keys stay manual commands. A label resolves on a fresh read exactly like `click`/`type` do; `@N`
  refs are rejected (they go stale between reads), and a missing or ambiguous
  label fails the step instead of guessing.
- **Assertions** state only what a dump can observe: `{"window": "About"}`
  (the window's title contains it), `{"exists": "macOS"}` (a control label or
  the window's text contains it) or `{"absent": "..."}`. No shell, no callbacks.
- **The checkpoint.** After each press the window is re-read until it differs
  from the pre-press read, then `post` is polled for up to 1 s (an async update
  is not a mismatch). The first mismatch — a label no longer on screen, a ref the
  driver refuses as stale before pressing, or a failed `post` — stops the script;
  the Jev loop then replans the whole goal from the current window once
  (`"recovery": 0` or `1`, default 1; steps after the failed one are not re-run,
  and there is never a second recovery). A recovery that stops (risky label,
  BLOCKED, low confidence) is final.
- **The goal is checked independently.** After the last step (or a recovery), a
  fresh read must satisfy `success` on its own. A click's exit status, the
  steps' postconditions or a DONE never stand in for it.
- **Risky steps are refused, on what they resolve to.** A plan whose wording
  looks irreversible (delete, buy, sign out …) is rejected before the first read;
  at run time the control a label RESOLVES to is checked again ("All Data" can
  resolve to "Delete All Data"), and a generic OK/Continue/Confirm on a window
  whose text looks irreversible is refused too. Either stops the plan outright:
  nothing pressed, no recovery. There is no `--allow-risky` for plans — that
  stays a manual, human-chosen command.
- `--dry-run` resolves and validates every step against the current window and
  executes nothing (no press, no recovery); it fails if a step hits a safety stop.

The command prints one line per step, any recovery steps, and a final
`plan done:`/`plan failed:` line with the full result as JSON: per-step action
and verify timings, recovery count, the final window and each check.

## How it works

A small Swift driver, `lib/ax.swift`, does the Accessibility work. `mac` builds
it with `swiftc` on first use (and again whenever the source changes) into
`~/.cache/mac`. Each call is one short process that reads the window fresh, so
nothing is kept between calls; `@N` refs are checked against the label and role
the last `dump` saw. The Accessibility permission belongs to the app that runs
`mac` (the terminal or agent app); `setup` asks for it once.

`flow` is the driver for the Jev loop in `lib/jev.mjs`: each step reads the app
once and asks TypeSafe's Jev (~0.3 s) for the next operation and target in one
request. Jev only chooses among what the dump listed; text comes from
`--value NAME=TEXT` / `--secret NAME=ENVVAR`. It stops and lists the choices on
low confidence, BLOCKED, a stuck screen or a risky label (delete, buy, sign
out: `--allow-risky`), and a goal that ends on a page it can reach directly is
verified by that page's title. A press the driver refuses as a stale ref (the
control moved between the read and the press; nothing pressed) re-reads the
current window and decides again, at most twice per run within the step budget;
the old ref is never retried. A small local decision model was slower than an
agent chaining the steps itself (12.6 s vs 1.9 s) and chose wrong paths: use
`flow` for unattended runs.

`plan` (`lib/plan.mjs`) is the hybrid on top of both: the plan's steps are
pressed deterministically and each is verified against what the window actually
shows; only a mismatch hands control to the Jev loop, and the goal is accepted
only on the plan's own assertions against a fresh read.

The decision model is pluggable: `TYPESAFE_API_KEY` uses Jev; or set `DECISION_URL`
(OpenAI-compatible, e.g. a company gateway or local model) + `DECISION_MODEL` to drive
`flow` with a normal chat model and no Jev key — it still only picks among listed elements.
