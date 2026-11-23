#!/bin/bash
# Hermetic check: only a browser's dump goes through page JavaScript. A stub driver and a stub
# osascript stand in; Obsidian once matched "dia" and its dump waited 30 s on JavaScript.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/mac" "$T/bin"; D="$T/mac/mac-ax-$(shasum -a 256 lib/ax.swift | cut -c1-12)"
printf '#!/bin/sh\necho "{\\"app\\":\\"x\\",\\"window\\":\\"w\\",\\"items\\":[],\\"context\\":[]}"\n' > "$D"; chmod +x "$D"
printf '#!/bin/sh\necho osa >> "%s/calls"\nexit 1\n' "$T" > "$T/bin/osascript"; chmod +x "$T/bin/osascript"
fail=0
for case in "Obsidian 0" "md.obsidian 0" "Archive Utility 0" "WeChat 0" "Dia 1" "Google Chrome 1" "com.microsoft.edgemac 1" "company.thebrowser.Browser 1"; do
  app=${case% *}; want=${case##* }; : > "$T/calls"
  PATH="$T/bin:$PATH" XDG_CACHE_HOME="$T" bin/mac dump --app "$app" >/dev/null 2>&1
  got=$([ -s "$T/calls" ] && echo 1 || echo 0)
  [ "$got" = "$want" ] && echo "ok   $app" || { echo "FAIL $app: page JavaScript $got, want $want"; fail=1; }
done
exit $fail
