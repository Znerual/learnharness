/**
 * THE DEVICE IDENTITY (multi-device, GLOSSARY "Device"): local/device.json
 * holds this installation's stable id and its learner-editable name. The id
 * keys this device's graph ledgers and marks the turns and jobs it owns; the
 * name is what other devices show ("running on Desktop"). Device-local:
 * never synced, created on first use. LH_DEVICE_NAME sets the default name
 * (the Android shell passes "Phone").
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEVICE_FILE } from "../../config.ts";

export interface Device {
	/** "dev_" + 8 lowercase alphanumerics; never changes once created. */
	id: string;
	name: string;
}

const ID_RE = /^dev_[a-z0-9]{8}$/;

function newId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return `dev_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

function write(device: Device): void {
	fs.mkdirSync(path.dirname(DEVICE_FILE), { recursive: true });
	const tmp = `${DEVICE_FILE}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	fs.writeFileSync(tmp, JSON.stringify(device, null, "\t"), "utf-8");
	fs.renameSync(tmp, DEVICE_FILE);
}

function read(): Device | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(DEVICE_FILE, "utf-8")) as Partial<Device>;
		if (typeof parsed.id === "string" && ID_RE.test(parsed.id) && typeof parsed.name === "string" && parsed.name.trim()) {
			return { id: parsed.id, name: parsed.name };
		}
	} catch {
		/* absent or corrupt: fall through */
	}
	return null;
}

/** This device — created on first call (a corrupt file is replaced only when
 *  it carries no valid id, so an existing identity is never re-rolled). */
function getDevice(): Device {
	const existing = read();
	if (existing) return existing;
	const device = { id: newId(), name: process.env.LH_DEVICE_NAME?.trim() || "Desktop" };
	write(device);
	return device;
}

function renameDevice(name: string): Device {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Device name must not be empty");
	const device = { id: getDevice().id, name: trimmed };
	write(device);
	return device;
}

export const deviceStore = { getDevice, renameDevice };
