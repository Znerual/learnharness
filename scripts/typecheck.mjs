/**
 * `npm run typecheck`. The vault client (@znerual/learnharness-vault-client) is a private optional
 * dependency, so in a checkout without it the vault glue is checked against its stand-in types
 * (src/server/vault/client-shim.d.ts, via tsconfig.novault.json) instead of the real ones.
 * next.config.ts makes the same choice for `next build`.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let installed = true;
try {
	require.resolve("@znerual/learnharness-vault-client");
} catch {
	installed = false;
}
const args = installed ? ["--noEmit"] : ["-p", "tsconfig.novault.json", "--noEmit"];
if (!installed) console.log("[typecheck] vault client not installed: checking against src/server/vault/client-shim.d.ts");
const tsc = require.resolve("typescript/bin/tsc");
process.exit(spawnSync(process.execPath, [tsc, ...args], { stdio: "inherit" }).status ?? 1);
