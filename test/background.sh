#!/bin/bash
# Live check, for when nobody is using the Mac (Chrome can show for a moment on launch),
# that every gesture reaches a covered Chromium window while the front app stays
# in front: a private Chrome opens test/fixture.html, which writes each event into its title.
# Needs Google Chrome and the Accessibility grant; prints one line per check, exit 1 on a failure.
set -u
cd "$(dirname "$0")/.."
M=bin/mac A="Google Chrome" T=$(mktemp -d)
pgrep -xq "Google Chrome" && { echo "quit Google Chrome first: the check runs its own"; exit 2; }
[ "$(ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked raw - 2>/dev/null)" = true ] \
  && { echo "the screen is locked: background input needs an unlocked session, nothing run"; exit 2; }
front() { osascript -e 'tell application "System Events" to get bundle identifier of first process whose frontmost is true'; }
before=$(front)
"$M" setup >/dev/null 2>&1; D=~/.cache/mac/mac-ax-$(shasum -a 256 lib/ax.swift | cut -c1-12) # the driver mac builds
# launched the way mac launches apps: in the background, the front handed straight back
"$D" launch "$A" -n --args --user-data-dir="$T" --no-first-run --no-default-browser-check \
  --window-position=200,150 --window-size=700,600 "file://$PWD/test/fixture.html" >/dev/null
for _ in $(seq 20); do "$M" dump --app "$A" 2>/dev/null | grep -q '"field"' && break; sleep 0.25; done
[ "$(front)" = "$before" ] || echo "FAIL launch took the front: $(front), was $before"
fails=0
check() { # check WANT CMD...: run a gesture, then the page title must end with WANT
  local want=$1; shift
  local t0=$(perl -MTime::HiRes=time -e 'print time')
  "$M" "$@" --app "$A" >/dev/null || { echo "FAIL $*: command failed"; fails=$((fails+1)); return; }
  local ms=$(perl -MTime::HiRes=time -e "print int((time-$t0)*1000)") title=""
  for _ in 1 2 3 4 5 6; do sleep 0.15; title=$("$M" dump --app "$A" | head -1); [[ "$title" == *$want" - Google Chrome\"" ]] && break; done
  [ "$(front)" = "$before" ] || echo "FAIL $* took the front: $(front)"
  if [[ "$title" == *$want" - Google Chrome\"" ]]; then echo "ok   $* (${ms} ms)"; else echo "FAIL $*: title $title, want …$want"; fails=$((fails+1)); fi
}
check click click --at 200,250
check dbl click --at 200,250 --double
check right click --at 200,250 --right
check "drag200 click" drag --at 100,200 --to 300,260
check "y[1-9]*" scroll down --lines 10
check "y0" scroll up --lines 30
check "val=hello" type field hello
check key:Escape key escape
[ "$(front)" = "$before" ] && echo "ok   front app unchanged ($before)" || { echo "FAIL front app is now $(front), was $before"; fails=$((fails+1)); }
osascript -e "quit app \"$A\"" >/dev/null; rm -rf "$T"
echo "$fails failed"; exit $((fails > 0))
