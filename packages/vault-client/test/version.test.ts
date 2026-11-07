import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { clientVersion } from "../src/index.ts";

test("clientVersion matches package.json", () => {
	const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
	assert.equal(clientVersion, pkg.version);
});
