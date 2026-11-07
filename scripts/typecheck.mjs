/**
 * `npm run typecheck`: the app (tsconfig.json), then the vault client package with its own,
 * stricter settings (packages/vault-client/tsconfig.json: exactOptionalPropertyTypes and more).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
for (const project of ["tsconfig.json", "packages/vault-client/tsconfig.json"]) {
	const status = spawnSync(process.execPath, [tsc, "-p", project, "--noEmit"], { stdio: "inherit" }).status ?? 1;
	if (status !== 0) process.exit(status);
}
