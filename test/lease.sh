#!/bin/bash
# Hermetic check: an action waits on the app's lease whatever name reaches the app, and
# --front waits on the screen's one front. A stub driver stands in; it names every app pid 4242.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/mac"; D="$T/mac/mac-ax-$(shasum -a 256 lib/ax.swift | cut -c1-12)"
printf '#!/bin/sh\necho "$1" >> "%s/calls"\n[ "$1" = pid ] && echo 4242\nexit 0\n' "$T" > "$D"; chmod +x "$D"
hold() { mkdir "$T/mac/lease-$(printf '%b' "$1" | shasum -a 256 | cut -c1-12)"; }
free() { rm -rf "$T"/mac/lease-*; }
fail=0
expect_busy() { # NAME ARGS...: the action must exit 5 and never reach the driver
  local name=$1; shift; : > "$T/calls"
  XDG_CACHE_HOME="$T" bin/mac "$@" 2>/dev/null; rc=$?
  if [ "$rc" = 5 ] && ! grep -qx key "$T/calls"; then echo "ok   $name"; else echo "FAIL $name: exit $rc, driver calls: $(tr '\n' ' ' < "$T/calls")"; fail=1; fi
}
hold 4242
expect_busy "a bundle id waits on the lease its app's name holds" key --app com.apple.finder escape
free; hold '\0front'
expect_busy "--front waits while another agent holds the front" key --app Finder escape --front
free; : > "$T/calls"
XDG_CACHE_HOME="$T" bin/mac key --app Finder escape --front >/dev/null 2>&1 && grep -qx key "$T/calls" \
  && echo "ok   a free front lets --front through" || { echo "FAIL a free front blocked --front"; fail=1; }
exit $fail
