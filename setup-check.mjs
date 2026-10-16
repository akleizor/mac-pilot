// A missing piece must fail the check: `mac-pilot setup` and the CI both run this
// against a fresh cache with no Swift compiler on PATH.
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
const bin = join(dirname(fileURLToPath(import.meta.url)), "bin", "mac-pilot");
const run = (env) => { try { execFileSync(bin, ["setup"], { env: { ...process.env, ...env }, encoding: "utf8" }); return 0; } catch (e) { return e.status; } };
let failures = 0;
const check = (name, got, want) => { const ok = got === want; if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: exit ${got}, want ${want}`); };
if (!process.env.CI) check("with everything installed", run({}), 0); // CI runners have no Accessibility grant
// a PATH with node and the shell tools but no swiftc, and an empty cache: the driver cannot be built
const bare = mkdtempSync(join(tmpdir(), "mac-pilot-check-"));
symlinkSync(process.execPath, join(bare, "node"));
for (const tool of ["readlink", "dirname", "open"]) symlinkSync(`/usr/bin/${tool}`, join(bare, tool));
check("with no Swift on PATH", run({ PATH: `${bare}:/bin`, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "mac-pilot-cache-")) }), 1);
console.log(failures ? `${failures} failed` : "self-check passed");
process.exitCode = failures ? 1 : 0;
