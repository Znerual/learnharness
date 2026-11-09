import assert from "node:assert/strict";
import { test } from "node:test";

import { generateBackupCodes, generateRecoveryKey, guessRecoveryKind, parseRecoverySecret } from "../src/crypto/index.ts";

test("recovery text with any whitespace parses like the dashed form", () => {
	const rk = generateRecoveryKey();
	const spaced = rk.display().replace(/-/g, " \t\n");
	assert.equal(guessRecoveryKind(spaced), "recovery_key");
	assert.deepEqual(parseRecoverySecret("recovery_key", spaced).secretBytes, rk.secretBytes);
	const c = generateBackupCodes(1)[0]!;
	assert.deepEqual(parseRecoverySecret("backup_code", ` ${c.display().replace(/-/g, " ")}\n`).secretBytes, c.secretBytes);
});
