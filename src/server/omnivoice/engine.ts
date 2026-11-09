/**
 * THE BUILT-IN VOICE ENGINE'S PROCESS (owner, 2026-11-09): omnivoice-rs's
 * OpenAI-compatible server, started on the first read-aloud request and
 * stopped after IDLE_MS without one, when the voice engine is removed, and
 * when this server exits.
 *
 * - Loopback only, on a free port, with a fresh API key per start; nothing
 *   outside this server can reach it.
 * - `--served-model-id tts-1`: the model name read-aloud sends.
 * - Requests run one at a time (the engine's own limit is one at a time, and
 *   it refuses a second): read-aloud fetches up to three blocks ahead, so they
 *   queue here.
 * - The CUDA builds load the CUDA libraries from the downloaded folder
 *   (assets.ts; LD_LIBRARY_PATH on Linux, PATH on Windows).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { OMNIVOICE_MODEL_DIR, type OmniVoicePlatform } from "./assets.ts";
import { omniVoiceDir, omniVoiceInstalled, omniVoiceSupport } from "./install.ts";

/** Stop the engine after this long without a request (frees the GPU memory, about 2 GB). */
const IDLE_MS = 10 * 60_000;
/** Loading the model takes ~20 s the first time on the owner's laptop; allow a slow disk. */
const START_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 120_000;
/** The last lines the engine printed, for the error a failed start reports. */
const LOG_LINES = 20;

interface Running {
	child: ChildProcess;
	url: string;
	key: string;
	ready: Promise<void>;
	exited: boolean;
	log: string[];
}

/** One engine per server process: Next loads a module once per route bundle, so the state lives on globalThis. */
interface EngineState {
	current: Running | null;
	idleTimer: NodeJS.Timeout | null;
	queue: Promise<unknown>;
	exitHooks: boolean;
}
const ENGINE_KEY = Symbol.for("lh.omnivoiceEngine");
const g: EngineState = ((globalThis as Record<symbol, EngineState | undefined>)[ENGINE_KEY] ??= {
	current: null,
	idleTimer: null,
	queue: Promise.resolve(),
	exitHooks: false,
});

export function omniVoiceRunning(): boolean {
	return g.current !== null && !g.current.exited;
}

/** Stop the engine process, if it runs. */
export function stopOmniVoice(): void {
	if (g.idleTimer) clearTimeout(g.idleTimer);
	g.idleTimer = null;
	const running = g.current;
	g.current = null;
	if (running && !running.exited) running.child.kill();
}

/** Next's server turns SIGTERM and SIGINT into process.exit, so "exit" covers a normal shutdown. */
function installExitHooks(): void {
	if (g.exitHooks) return;
	g.exitHooks = true;
	process.once("exit", stopOmniVoice);
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
		});
	});
}

async function start(platform: OmniVoicePlatform): Promise<Running> {
	const dir = omniVoiceDir();
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (platform.libraries) {
		const libs = path.join(dir, platform.libraries);
		if (process.platform === "win32") env.PATH = `${libs};${env.PATH ?? ""}`;
		else env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${libs}:${env.LD_LIBRARY_PATH}` : libs;
	}
	const key = randomBytes(24).toString("hex");
	env.OMNIVOICE_API_KEY = key;
	const port = await freePort();
	const child = spawn(
		path.join(dir, platform.server),
		[
			"--model", path.join(dir, OMNIVOICE_MODEL_DIR),
			"--host", "127.0.0.1",
			"--port", String(port),
			"--device", platform.device === "cuda" ? "cuda:0" : "metal",
			"--dtype", "f16",
			"--served-model-id", "tts-1",
		],
		{ env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
	);
	const running: Running = { child, url: `http://127.0.0.1:${port}`, key, ready: Promise.resolve(), exited: false, log: [] };
	const remember = (chunk: Buffer) => {
		for (const line of chunk.toString("utf8").split(/\r?\n/)) {
			const clean = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
			if (!clean) continue;
			running.log.push(clean);
			if (running.log.length > LOG_LINES) running.log.shift();
		}
	};
	child.stdout?.on("data", remember);
	child.stderr?.on("data", remember);
	child.once("exit", (code, signal) => {
		running.exited = true;
		if (g.current === running) g.current = null;
		if (code !== 0 && signal !== "SIGTERM") console.error(`[omnivoice] engine exited (${signal ?? code}): ${running.log.slice(-3).join(" | ")}`);
	});
	child.once("error", (error) => {
		running.exited = true;
		running.log.push(error.message);
	});
	running.ready = waitReady(running);
	return running;
}

async function waitReady(running: Running): Promise<void> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (running.exited) throw new Error(`The voice engine stopped while starting: ${running.log.slice(-3).join(" | ") || "no output"}`);
		// /health answers 200 {"status":"starting"} while the model loads; only "ok" takes requests.
		const ok = await fetch(`${running.url}/health`, { signal: AbortSignal.timeout(2000) })
			.then(async (r) => r.ok && ((await r.json()) as { status?: string }).status === "ok", () => false);
		if (ok) return;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	running.child.kill();
	throw new Error("The voice engine did not start in time");
}

async function ensureRunning(): Promise<Running> {
	if (g.current && !g.current.exited) {
		await g.current.ready;
		return g.current;
	}
	const { platform, reason } = await omniVoiceSupport();
	if (!platform) throw new OmniVoiceUnavailable(reason ?? "Not supported on this computer");
	if (!(await omniVoiceInstalled())) throw new OmniVoiceUnavailable("The voice engine is not downloaded yet (Settings → Read aloud)");
	installExitHooks();
	const running = await start(platform);
	g.current = running;
	try {
		await running.ready;
	} catch (error) {
		if (g.current === running) g.current = null;
		throw error;
	}
	return running;
}

/** The engine cannot run here, or is not installed: a 503, not an engine failure. */
export class OmniVoiceUnavailable extends Error {}

function touch(): void {
	if (g.idleTimer) clearTimeout(g.idleTimer);
	g.idleTimer = setTimeout(stopOmniVoice, IDLE_MS);
	g.idleTimer.unref();
}

export interface OmniVoiceReply {
	status: number;
	contentType: string;
	body: Uint8Array<ArrayBuffer>;
}

/** POST /v1/audio/speech on the engine (JSON or multipart), one request at a time. */
export function omniVoiceSpeech(body: string | FormData): Promise<OmniVoiceReply> {
	const job = g.queue.then(async () => {
		const running = await ensureRunning();
		touch();
		try {
			const res = await fetch(`${running.url}/v1/audio/speech`, {
				method: "POST",
				headers: { Authorization: `Bearer ${running.key}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
				body,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			return { status: res.status, contentType: res.headers.get("content-type") ?? "application/octet-stream", body: new Uint8Array(await res.arrayBuffer()) };
		} finally {
			touch();
		}
	});
	g.queue = job.catch(() => undefined);
	return job;
}
