#!/bin/bash
# Hermetic check: without the Accessibility grant, `mac allow` asks the driver once and never sweeps.
# Each sweep is a TCC check; Hive gates polling every 3 s kept tccd's queue full and hung SN850X (2026-11-19).
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/mac"; D="$T/mac/mac-ax-$(shasum -a 256 lib/ax.swift | cut -c1-12)"
printf '#!/bin/sh\necho "$1" >> "%s/calls"\n[ "$1" = trusted ] && echo "not granted"\nexit 0\n' "$T" > "$D"; chmod +x "$D"
XDG_CACHE_HOME="$T" bin/mac allow -- sh -c 'sleep 4; exit 3' 2>/dev/null; rc=$?
[ "$rc" = 3 ] || { echo "FAIL exit $rc, want CMD's 3"; exit 1; }
[ "$(cat "$T/calls")" = trusted ] || { echo "FAIL driver calls: $(tr '\n' ' ' < "$T/calls")"; exit 1; }
echo "ok allow without the grant runs CMD and never sweeps"
