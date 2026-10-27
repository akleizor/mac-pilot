#!/bin/bash
# Live check of the web path: a private Chrome with JavaScript from Apple Events allowed opens
# test/fixture.html behind the front app; dump, type, key return, scroll, click and js must work
# through the page, tab must open the agent's own window and a real click must land there,
# and Chrome must never stay in front. Exit 1 on a failure.
set -u
cd "$(dirname "$0")/.."
M=bin/mac A="Google Chrome" T=$(mktemp -d)
pgrep -xq "Google Chrome" && { echo "quit Google Chrome first: the check runs its own"; exit 2; }
mkdir -p "$T/Default" && echo '{"browser":{"allow_javascript_apple_events":true}}' > "$T/Default/Preferences"
"$M" setup >/dev/null 2>&1; D=~/.cache/mac/mac-ax-$(shasum -a 256 lib/ax.swift | cut -c1-12)
"$D" launch "$A" -n --args --user-data-dir="$T" --no-first-run --no-default-browser-check \
  --window-position=200,150 --window-size=700,600 "file://$PWD/test/fixture.html" >/dev/null
for _ in $(seq 20); do "$M" js --app "$A" 'document.title' 2>/dev/null | grep -q ready && break; sleep 0.25; done
fails=0
check() { # check WANT CMD...: the command's output, then the page title, must show WANT
  local want=$1; shift
  local out; out=$("$M" "$@" --app "$A" 2>&1) || { echo "FAIL $*: $out"; fails=$((fails+1)); return; }
  local title; title=$("$M" js --app "$A" 'document.title')
  if [[ "$out $title" == *$want* ]]; then echo "ok   $*"; else echo "FAIL $*: $out | $title, want $want"; fails=$((fails+1)); fi
}
check '"field"' dump
check "val=hello" type field hello
check "key:Enter" key return
check "scrolled 400 px" scroll down --lines 10
check "y400" js 'document.title'
check "4" js '2+2'
check "click" click pad
check "opened" tab "file://$PWD/test/fixture.html?own"
check '"pad"' dump
check "click" click --real pad
check "saved" shot "$T/own.png"
check "recording" record "$T/own.mov" --seconds 2
sleep 3; [ -s "$T/own.mov" ] && echo "ok   recorded the agent's window" || { echo "FAIL no recording"; fails=$((fails+1)); }
[ "$("$D" front)" != com.google.Chrome ] && echo "ok   Chrome never came to the front" || { echo "FAIL Chrome is in front"; fails=$((fails+1)); }
osascript -e "quit app \"$A\"" >/dev/null
for _ in $(seq 40); do pgrep -f -- "--user-data-dir=$T" >/dev/null || break; sleep 0.25; done; rm -rf "$T"
echo "$fails failed"; exit $((fails > 0))
