/**
 * GET/PUT /api/device — this device's identity (multi-device, GLOSSARY
 * "Device"): the stable id and the learner-editable name other devices
 * show. Device-local (local/device.json), never synced.
 *
 *   GET → 200 {device: {id, name}}
 *   PUT {name} → 200 {device} | 400 {error} for a missing or empty name
 */

import { stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ device: stores.deviceStore.getDevice() });
}

export async function PUT(request: Request) {
	const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
	if (typeof body?.name !== "string" || !body.name.trim()) {
		return Response.json({ error: "Device name must be a non-empty string" }, { status: 400 });
	}
	return Response.json({ device: stores.deviceStore.renameDevice(body.name) });
}
