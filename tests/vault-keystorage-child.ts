// Runs as the "server process" in the tests: IpcKeyStorage driven by commands from the parent.
import { decodeBundle, encodeBundle } from "@znerual/learnharness-vault-client";

import { IpcKeyStorage } from "../src/server/vault/keystorage-ipc.ts";

const ks = new IpcKeyStorage({ timeoutMs: 3000 });

async function run(cmd: string, arg: string | undefined): Promise<unknown> {
	switch (cmd) {
		case "status": return ks.status();
		case "load": { const b = await ks.load(); return b === null ? null : encodeBundle(b); }
		case "save": await ks.save(decodeBundle(arg!)); return null;
		case "clear": await ks.clear(); return null;
		default: throw new Error("unknown cmd");
	}
}

if (typeof process.send === "function") {
	process.on("message", async (m: { channel?: string; id?: number; cmd?: string; arg?: string }) => {
		if (m.channel !== "test:cmd") return;
		try {
			process.send!({ channel: "test:res", id: m.id, ok: true, value: await run(m.cmd!, m.arg) });
		} catch (e) {
			process.send!({ channel: "test:res", id: m.id, ok: false, code: (e as { code?: string }).code, message: (e as Error).message });
		}
	});
} else {
	// No IPC channel at all (e.g. `next dev` started by hand).
	console.log(JSON.stringify(await ks.status()));
}
