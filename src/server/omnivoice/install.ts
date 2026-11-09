/**
 * THE BUILT-IN VOICE ENGINE'S INSTALL (owner, 2026-11-09): whether this
 * computer can run it, and the download the user starts in Settings → Read
 * aloud. Everything lands in the device-local folder (<local>/omnivoice), never
 * in the synced data folder: the files are per machine and large (Linux: about
 * 4.7 GB to download, 6 GB unpacked).
 *
 * - GPU only: an NVIDIA driver (nvidia-smi answers) on Linux and Windows x64,
 *   or Apple silicon. Without one the choice is offered but explains why it
 *   cannot be used.
 * - Each file is downloaded to `<path>.part`, checked against its pinned size
 *   and SHA-256, then renamed; an archive is unpacked with the system's `tar`
 *   (Windows 10+ ships bsdtar, which reads .zip too), a wheel's few libraries
 *   with unzip.ts, and the download is deleted. A failed install keeps what
 *   is complete, so a retry continues from there.
 * - `installed.json` is written last: only then is the engine "ready".
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { unzipPicked } from "./unzip.ts";
import { PATHS } from "../../../config.ts";
import {
	OMNIVOICE_MODEL_DIR,
	OMNIVOICE_MODEL_REVISION,
	OMNIVOICE_RELEASE,
	omniVoiceFiles,
	omniVoicePlatform,
	type OmniVoiceDevice,
	type OmniVoiceFile,
	type OmniVoicePlatform,
} from "./assets.ts";

const run = promisify(execFile);

/** The engine folder. A function, so tests can move PATHS.local first. */
export function omniVoiceDir(): string {
	return path.join(PATHS.local, "omnivoice");
}

export type OmniVoiceInstallState = "missing" | "downloading" | "ready" | "failed";

/** What Settings shows (GET /api/tts/engine). */
export interface OmniVoiceStatus {
	/** This computer can run the engine. */
	supported: boolean;
	/** Why not, when it cannot. */
	reason?: string;
	device?: OmniVoiceDevice;
	state: OmniVoiceInstallState;
	/** 0..1 while downloading. */
	progress: number;
	/** The whole download, in bytes. */
	bytes: number;
	error?: string;
	/** The engine process is up. */
	running: boolean;
}

export interface OmniVoiceSupport {
	platform: OmniVoicePlatform | null;
	reason?: string;
}


/** Whether this computer can run the engine; asked once per server run. */
export function omniVoiceSupport(): Promise<OmniVoiceSupport> {
	g.support ??= detectSupport();
	return g.support;
}

async function detectSupport(): Promise<OmniVoiceSupport> {
	const platform = omniVoicePlatform();
	if (!platform) return { platform: null, reason: "Needs Linux or Windows on x64 with an NVIDIA GPU, or a Mac with Apple silicon" };
	if (platform.device === "metal") return { platform };
	try {
		const { stdout } = await run("nvidia-smi", ["-L"], { timeout: 5000, windowsHide: true });
		if (/GPU \d+:/.test(stdout)) return { platform };
	} catch {
		// no driver, or nvidia-smi not on PATH
	}
	return { platform: null, reason: "Needs an NVIDIA GPU with its driver installed (nvidia-smi found none)" };
}

interface InstallProgress {
	state: "downloading" | "failed";
	done: number;
	total: number;
	error?: string;
}

/** One install per server process: Next loads a module once per route bundle, so the state lives on globalThis. */
interface InstallState {
	support: Promise<OmniVoiceSupport> | null;
	progress: InstallProgress | null;
	installing: Promise<void> | null;
}
const INSTALL_KEY = Symbol.for("lh.omnivoiceInstall");
const g: InstallState = ((globalThis as Record<symbol, InstallState | undefined>)[INSTALL_KEY] ??= { support: null, progress: null, installing: null });

async function fileSize(file: string): Promise<number | null> {
	return stat(file).then((s) => s.size, () => null);
}

export async function omniVoiceInstalled(): Promise<boolean> {
	const raw = await readFile(path.join(omniVoiceDir(), "installed.json"), "utf8").catch(() => null);
	if (!raw) return false;
	try {
		const marker = JSON.parse(raw) as { release?: string; revision?: string };
		return marker.release === OMNIVOICE_RELEASE && marker.revision === OMNIVOICE_MODEL_REVISION;
	} catch {
		return false;
	}
}

export async function omniVoiceStatus(running: boolean): Promise<OmniVoiceStatus> {
	const { platform, reason } = await omniVoiceSupport();
	const bytes = platform ? omniVoiceFiles(platform).reduce((sum, f) => sum + f.bytes, 0) : 0;
	const base = { supported: platform !== null, ...(reason ? { reason } : {}), ...(platform ? { device: platform.device } : {}), bytes, running };
	if (g.progress?.state === "downloading") return { ...base, state: "downloading", progress: g.progress.total ? g.progress.done / g.progress.total : 0 };
	if (await omniVoiceInstalled()) return { ...base, state: "ready", progress: 1 };
	if (g.progress?.state === "failed") return { ...base, state: "failed", progress: g.progress.total ? g.progress.done / g.progress.total : 0, ...(g.progress.error ? { error: g.progress.error } : {}) };
	return { ...base, state: "missing", progress: 0 };
}

/** Start the download (no-op while one runs or when installed). Resolves when it has started. */
export async function startOmniVoiceInstall(): Promise<{ ok: true } | { ok: false; error: string }> {
	const { platform, reason } = await omniVoiceSupport();
	if (!platform) return { ok: false, error: reason ?? "Not supported on this computer" };
	if (g.installing || (await omniVoiceInstalled())) return { ok: true };
	const files = omniVoiceFiles(platform);
	g.progress = { state: "downloading", done: 0, total: files.reduce((sum, f) => sum + f.bytes, 0) };
	g.installing = install(files)
		.then(() => {
			g.progress = null;
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[omnivoice] install failed", error);
			g.progress = { state: "failed", done: g.progress?.done ?? 0, total: g.progress?.total ?? 0, error: message };
		})
		.finally(() => {
			g.installing = null;
		});
	return { ok: true };
}

async function install(files: OmniVoiceFile[]): Promise<void> {
	const dir = omniVoiceDir();
	await mkdir(dir, { recursive: true });
	for (const file of files) {
		await fetchFile(dir, file);
		if (g.progress) g.progress.done += file.bytes;
	}
	await writeFile(
		path.join(dir, "installed.json"),
		JSON.stringify({ release: OMNIVOICE_RELEASE, revision: OMNIVOICE_MODEL_REVISION, model: OMNIVOICE_MODEL_DIR, at: new Date().toISOString() }, null, "\t") + "\n",
	);
}

async function fetchFile(dir: string, file: OmniVoiceFile): Promise<void> {
	const target = path.join(dir, file.path);
	// An unpacked archive is done once its folder has its marker (two wheels share one folder).
	const marker = file.extractTo ? path.join(dir, file.extractTo, `.complete-${path.basename(file.path)}`) : null;
	if (marker) {
		if ((await fileSize(marker)) !== null) return;
	} else if ((await fileSize(target)) === file.bytes) {
		return;
	}
	await mkdir(path.dirname(target), { recursive: true });
	const part = `${target}.part`;
	const res = await fetch(file.url, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${path.basename(file.path)}`);
	const hash = createHash("sha256");
	const before = g.progress?.done ?? 0;
	let received = 0;
	const counted = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
	counted.on("data", (chunk: Buffer) => {
		hash.update(chunk);
		received += chunk.length;
		if (g.progress) g.progress.done = before + Math.min(received, file.bytes);
	});
	await pipeline(counted, createWriteStream(part));
	if (g.progress) g.progress.done = before;
	const sha256 = hash.digest("hex");
	if (received !== file.bytes || sha256 !== file.sha256) {
		await rm(part, { force: true });
		throw new Error(`${path.basename(file.path)} did not match its pinned size and SHA-256`);
	}
	await rename(part, target);
	if (file.extractTo && marker) {
		const into = path.join(dir, file.extractTo);
		if (file.pick) {
			await mkdir(into, { recursive: true });
			await unzipPicked(target, into, file.pick);
		} else {
			await rm(into, { recursive: true, force: true });
			await mkdir(into, { recursive: true });
			await extract(target, into);
		}
		await rm(target, { force: true });
		await writeFile(marker, "");
	}
}

async function extract(archive: string, into: string): Promise<void> {
	// Windows: the system's bsdtar (System32), not a Git or MSYS tar that may come first on PATH.
	const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
	await run(tar, ["-xf", archive, "-C", into], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

/** Delete the engine and its model. The caller stops the process first. */
export async function removeOmniVoice(): Promise<{ ok: true } | { ok: false; error: string }> {
	if (g.installing) return { ok: false, error: "The download is still running" };
	await rm(omniVoiceDir(), { recursive: true, force: true });
	g.progress = null;
	return { ok: true };
}
