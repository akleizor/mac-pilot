# mac-pilot

Drive macOS apps from an AI agent or a script, through the accessibility API —
no screenshots, no cursor, no stolen focus.

```console
$ mac dump --app "System Settings" | head -4
System Settings — "General"
@1 [Button] "Alex Lee, Apple Account"
@2 [Button] "Software Update Available"
@3 [Button] "Add AppleCare Coverage,  "
$ mac click --app "System Settings" General
clicked Button "General"
$ mac flow "Open the About page in System Settings" --app "System Settings"
 1 jev  406ms CLICK       p=0.95  @36 Button "About" p=0.70
 2 jev  375ms DONE        p=0.86
done: 1 action(s) in 1.3s — {"app":"System Settings","window":"About"} (verify independently)
```

## What it does

- **Reads a window** as `@N` control references and its text (`dump`).
- **Acts** by label or reference: `click`, `type`, `key`, `menu`, `open`; a
  canvas takes `click --at X,Y`, and `shot` captures the window even when covered.
- **Works on Electron and Chromium apps** (TradingView, Lark, VS Code) in the
  background, through the SkyLight recipe of
  [open-computer-use](https://github.com/iFurySt/open-computer-use) (MIT).
- **Refuses instead of guessing**: a reference whose control moved, a label that
  matches twice, a field the command would not act on.
- **Runs a flow** (`flow "GOAL"`): each step reads the app and asks
  [TypeSafe Jev](https://typesafe.ai) to choose the next control (~0.3 s). It
  only chooses among what is on screen and stops on anything risky.
- **Runs a plan** (`plan FILE`): deterministic click/type steps, each with the
  observable postcondition it must leave on screen. The first mismatch stops the
  script and replans the whole goal from the current window through the flow
  loop — at most one recovery — and the goal is accepted only when the plan's
  own assertions hold on a fresh read. A step whose wording, or whose resolved
  control, looks irreversible stops the plan with nothing pressed and no
  recovery; keys are never plan steps.
- **Leaves the Mac alone.** Presses are accessibility presses and keys go to the
  named app, so your pointer, keyboard focus and front app never move. You can
  keep working while an agent drives another window.

A routine Settings flow takes 2–4 s.

## Requirements

- macOS with Swift (Xcode or `xcode-select --install`) and Node 18+.
- For `flow` only: a TypeSafe API key in `TYPESAFE_API_KEY`.

```bash
git clone https://github.com/akleizor/mac-pilot && cd mac-pilot
./bin/mac setup
```

`setup` builds the driver and asks macOS for the Accessibility permission, the one
grant any tool that presses other apps' controls needs. It opens that settings page
for the app you run `mac` from (your terminal or agent app) and continues once
you switch it on.

## Use with an agent

`SKILL.md` is an agent skill: point Claude Code, Codex or any agent that reads
skills at it, and it learns the commands, the targeting rules and how `flow`
behaves.

## Commands

| Command | Does |
|---|---|
| `dump` | Controls as `@N` refs, then the window's text |
| `click` · `type` · `key` · `menu` | Press a control, set a field, send keys, choose a menu item |
| `open` · `apps` | Launch in the background · list apps with a window |
| `flow` | A routine flow in one call, Jev choosing each step |
| `plan` | A JSON plan: deterministic steps, checked postconditions, one bounded recovery |
| `setup` | Build the driver and get the Accessibility permission |

Details, targeting rules and the password-dialog recipe are in
[SKILL.md](SKILL.md).

## How it works

A small Swift driver (`lib/ax.swift`, built on first use) reads each window's
controls through the macOS Accessibility API and presses them; the Node side shapes
the request and the answer. There is no background app or menu-bar icon.

`flow` is a driver for the Jev loop in `lib/jev.mjs`. Each step reads the app
once and asks Jev, a non-generative choice model, for the next operation and
target in a single request. It never invents selectors or text: text comes from
`--value` or `--secret`, and only the value's name leaves the Mac.

`plan` (`lib/plan.mjs`) is the hybrid on top of both: the plan's steps are
pressed deterministically and each is verified against what the window actually
shows; only a mismatch hands control to the Jev loop, and the goal is accepted
only on the plan's own assertions against a fresh read — never on a click's
exit status or a DONE.

## Limits

- Apps with no accessibility tree (games, canvases, some Electron windows) have
  nothing to press: those need screen-driven computer use.
- Privacy switches in System Settings cannot be flipped programmatically; macOS
  guards them. Answer the permission prompt instead.
- Toggling a switch inside a virtual machine or over a remote session can be
  slower to settle than the 2–4 s a flow budgets for.

## License

Apache-2.0 (see [LICENSE](LICENSE)).
