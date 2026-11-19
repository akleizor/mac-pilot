#!/bin/bash
# Check of mac vnc: the PNG encoder makes a valid, shrunk image, and (with MAC_PW set to the
# Mac login password and Screen Sharing on) a live shot reads a real frame. Exit 1 on a failure.
set -u
cd "$(dirname "$0")/.."
node --input-type=module -e '
import { png } from "./lib/vnc.mjs";
import { inflateSync } from "node:zlib";
const rgb = Buffer.alloc(4 * 2 * 3, 7), p = png({ w: 4, h: 2, rgb }, 2);
if (p.toString("latin1", 1, 4) !== "PNG" || p.readUInt32BE(16) !== 2 || p.readUInt32BE(20) !== 1) throw new Error("bad PNG header");
const idat = p.subarray(41, 41 + p.readUInt32BE(33)); if (inflateSync(idat).length !== 2 * 3 + 1) throw new Error("bad PNG body");
' || { echo "FAIL png"; exit 1; }
echo "ok png"
[ -n "${MAC_PW:-}" ] || { echo "skip live shot: MAC_PW not set"; exit 0; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
bin/mac vnc --secret MAC_PW shot "$T/s.png" --region 0,0,64,64 | grep -q "desktop " && [ -s "$T/s.png" ] \
  && echo "ok live shot" || { echo "FAIL live shot"; exit 1; }
