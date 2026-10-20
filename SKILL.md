---
name: mac-pilot
description: "Operate macOS apps the way a person would, without screenshots and without taking the user's pointer or focus: click buttons, choose menus, fill fields, press keys, answer password and permission dialogs. `mac flow` runs a routine flow in one call (Jev picks each step); dump, click, type, key, menu cover everything else. Use for any desktop app or system dialog ('open Displays settings', 'configure X in app Y', 'approve the admin password prompt'). Not for websites or phones, and not for apps with no accessibility tree (games, canvases) — those need screen-driven computer use."
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
- **Targets.** A label matches exactly, then by unique substring, among the
  controls the command acts on (fields for `type`). `@N` comes from the last
  `dump` and is checked against a fresh read: if that control is gone or
  ambiguous it is refused.
- **Nothing moves.** Presses, value sets and app-targeted keys leave the pointer,
  focus and front app alone. Exception: a menu item that opens a window can bring
  its app forward (Finder "New Finder Window" did).
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
  locked. The lock screen is the `loginwindow` app; unlock it with the same
  password, only after confirming the lock so the password can never land in an
  app:
  ```bash
  locked() { ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked raw - 2>/dev/null || echo false; }
  [ "$(locked)" = true ] && PW="$(your-password-tool)" \
    $M type --app loginwindow "Enter Password" --secret PW && $M key --app loginwindow return
  ```

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
the old ref is never retried.

`plan` (`lib/plan.mjs`) is the hybrid on top of both: the plan's steps are
pressed deterministically and each is verified against what the window actually
shows; only a mismatch hands control to the Jev loop, and the goal is accepted
only on the plan's own assertions against a fresh read.

The decision model is pluggable: `TYPESAFE_API_KEY` uses Jev; or set `DECISION_URL`
(OpenAI-compatible, e.g. a company gateway or local model) + `DECISION_MODEL` to drive
`flow` with a normal chat model and no Jev key — it still only picks among listed elements.
