/**
 * THE OWNING DEVICE (multi-device, GLOSSARY "Owning device", "Takeover"):
 * a session runs its turns and background jobs on one device at a time.
 * The running work names its device — ChatRecord.activeTurn for a turn,
 * JobRecord.deviceId for a job — and every other device keeps the session
 * read-only until that work settles and syncs, or the learner takes over.
 * This device's own leftover marker (a crash before the turn settled)
 * never blocks it.
 */

import { stores } from "./stores.ts";
import { deliverJobResult } from "./jobs.ts";
import { buildAbortSteer } from "../core/contracts.ts";

export interface ForeignOwner {
	deviceId: string;
	deviceName: string;
	/** When the owning work started. */
	since: string;
	kind: "turn" | "job";
}

/** The device other than this one that runs work in the session, or null. */
export function foreignOwner(chatId: string): ForeignOwner | null {
	const self = stores.deviceStore.getDevice().id;
	const turn = stores.chatStore.getChat(chatId)?.activeTurn;
	if (turn && turn.deviceId !== self) {
		return { deviceId: turn.deviceId, deviceName: turn.deviceName, since: turn.startedAt, kind: "turn" };
	}
	const job = stores.jobStore
		.listJobs(chatId)
		.find((j) => j.status === "running" && !j.result && j.deviceId !== undefined && j.deviceId !== self);
	if (job) {
		return { deviceId: job.deviceId!, deviceName: job.deviceName ?? "another device", since: job.createdAt, kind: "job" };
	}
	return null;
}

/** The 409 every refused write in a foreign-owned session answers with. */
export function ownedElsewhereResponse(owner: ForeignOwner): Response {
	return Response.json(
		{ error: `This session is running on ${owner.deviceName}`, code: "owned_elsewhere", owner },
		{ status: 409 },
	);
}

/** Mark this device as the owner of the turn that just began. */
export function claimTurn(chatId: string): void {
	const device = stores.deviceStore.getDevice();
	stores.chatStore.setActiveTurn(chatId, { deviceId: device.id, deviceName: device.name, startedAt: new Date().toISOString() });
}

/** Clear this device's turn marker (never another device's). */
export function releaseTurn(chatId: string): void {
	const record = stores.chatStore.getChat(chatId);
	if (record?.activeTurn?.deviceId === stores.deviceStore.getDevice().id) stores.chatStore.setActiveTurn(chatId, null);
}

/**
 * TAKEOVER: the learner confirmed that the other device's work in this
 * session is dead or may be abandoned. Clears its turn marker; its running
 * jobs end as "Taken over" and become this device's, so this device
 * delivers their abort notice to the teacher.
 */
export function takeOver(chatId: string): { jobsStopped: number } {
	const device = stores.deviceStore.getDevice();
	const record = stores.chatStore.getChat(chatId);
	if (record?.activeTurn && record.activeTurn.deviceId !== device.id) stores.chatStore.setActiveTurn(chatId, null);
	let jobsStopped = 0;
	for (const job of stores.jobStore.listJobs(chatId)) {
		if (job.status !== "running" || job.result || job.deviceId === undefined || job.deviceId === device.id) continue;
		const stopped = stores.jobStore.updateJob(job.id, {
			status: "error",
			error: `Taken over on ${device.name}`,
			activity: "taken over",
			deviceId: device.id,
			deviceName: device.name,
			delivery: { kind: "abort", status: "pending" },
		});
		jobsStopped++;
		if (stopped) {
			void deliverJobResult(buildAbortSteer(stopped)).catch(() => {
				/* The saved pending abort notice remains owned by the session. */
			});
		}
	}
	return { jobsStopped };
}
