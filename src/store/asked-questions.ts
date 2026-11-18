/**
 * QUESTIONS THIS DEVICE ASKED (owner, 2026-11-18). A pending plugin question or practice problem
 * is part of a session record, and session records sync between the learner's devices. Submitting
 * an answer to a graded question runs plugin code on the saved question: the coding questions
 * plugin, for one, starts the program the question's tests name. A device of the learner that was
 * taken over could therefore write a session whose pending question starts a program of the
 * attacker's choice on every other device where the learner answers it.
 *
 * This device-local list holds the ids of the questions and problems that this device's own agent
 * asked, and of those the learner allowed here by hand. A graded question whose id is not in the
 * list came from somewhere else (another device, or a version from before the list existed). Its
 * checks do not run until the learner allows them on this device.
 *
 * The file never syncs (it lives in the device-local folder). It keeps the newest ids only; an id
 * that fell out of it needs one more confirmation, nothing worse.
 */

import * as fs from "node:fs";
import { ASKED_QUESTIONS_FILE } from "../../config.ts";
import { writeFileAtomic } from "./fs-files.ts";

const MAX_IDS = 20_000;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

let cache: { file: string; ids: Set<string> } | undefined;

function load(): Set<string> {
	if (cache?.file === ASKED_QUESTIONS_FILE) return cache.ids;
	const ids = new Set<string>();
	try {
		const parsed = JSON.parse(fs.readFileSync(ASKED_QUESTIONS_FILE, "utf-8")) as { ids?: unknown };
		if (Array.isArray(parsed.ids)) for (const id of parsed.ids) if (typeof id === "string" && ID_RE.test(id)) ids.add(id);
	} catch {
		/* absent or corrupt: an empty list, so every graded question asks once */
	}
	cache = { file: ASKED_QUESTIONS_FILE, ids };
	return ids;
}

/** Records that this device asked, or the learner allowed, the question or problem `id`. */
export function rememberAskedQuestion(id: string): void {
	if (!ID_RE.test(id)) return;
	const ids = load();
	if (ids.has(id)) return;
	ids.add(id);
	// A Set keeps insertion order: drop the oldest ids beyond the cap.
	for (const old of ids) {
		if (ids.size <= MAX_IDS) break;
		ids.delete(old);
	}
	try {
		writeFileAtomic(ASKED_QUESTIONS_FILE, JSON.stringify({ ids: [...ids] }));
	} catch {
		/* the list still holds for this run; a later write stores it */
	}
}

/** True when this device asked the question or problem `id`, or the learner allowed it here. */
export function askedOnThisDevice(id: string): boolean {
	return load().has(id);
}

/** Tests only: forget the loaded list, so the next call reads the file again. */
export function resetAskedQuestionsCache(): void {
	cache = undefined;
}
