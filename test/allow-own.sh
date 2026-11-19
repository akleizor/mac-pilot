#!/bin/bash
# Hermetic check: `mac allow --own NAME` answers any prompt NAME raised, and only that kind
# beyond removable-volume/local-network; without --own the same prompt is left for a person.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/mac"; D="$T/mac/mac-ax-$(shasum -a 256 lib/ax.swift | cut -c1-12)"
cat > "$D" <<STUB
#!/bin/sh
echo "\$1" >> "$T/calls"
case "\$1" in
  trusted) echo granted ;;
  dump) [ -e "$T/answered" ] && echo '{"app":"UNC","window":"","items":[],"context":[]}' \
        || echo '{"app":"UNC","window":"","items":[{"ref":1,"role":"Button","label":"Allow"}],"context":["“tcc-host” wants access to control “System Events”."]}' ;;
  click) touch "$T/answered"; echo clicked ;;
esac
exit 0
STUB
chmod +x "$D"
run() { rm -f "$T/calls" "$T/answered"; XDG_CACHE_HOME="$T" bin/mac allow "$@" 2>/dev/null; }
run; grep -q click "$T/calls" && { echo "FAIL a control prompt was answered without --own"; exit 1; }
run --own other; grep -q click "$T/calls" && { echo "FAIL --own other answered tcc-host's prompt"; exit 1; }
run --own tcc-host; grep -q click "$T/calls" || { echo "FAIL --own tcc-host left its own prompt: $(tr '\n' ' ' < "$T/calls")"; exit 1; }
echo "ok allow --own answers exactly the prompts its launcher raised"
