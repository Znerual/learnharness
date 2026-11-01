// Pairing (#32, ADR 0003). Approver side (a signed-in device): show a QR code and the 52-character
// text code, wait for the join, show the new device's name and 6-digit code, approve only after
// the learner confirms the codes match. Joiner side (the new device): either scan or paste the
// approver's code, or show its own code; it displays the same 6-digit code.

interface Common {
	busy: boolean;
	error?: string;
}

// ---------------------------------------------------------------- approver

export type ApproverState =
	| ({ step: "idle" } & Common)
	| ({ step: "showing"; pairingId: string; qr: string; text: string } & Common)
	| ({ step: "review"; pairingId: string; deviceName: string; code: string } & Common)
	| { step: "approved"; busy: false; deviceName: string }
	| { step: "cancelled"; busy: false }
	| { step: "failed"; busy: false; error: string };

export type ApproverEvent =
	| { type: "start" }
	| { type: "shown"; pairingId: string; qr: string; text: string }
	| { type: "reviewed"; name: string; code: string }
	| { type: "approve" }
	| { type: "approved" }
	| { type: "reject" }
	| { type: "failed"; code: string };

export const initialApprover: ApproverState = { step: "idle", busy: false };

export function reduceApprover(s: ApproverState, e: ApproverEvent): ApproverState {
	if (e.type === "failed") {
		if (e.code === "pairing_timeout" || e.code === "pairing_cancelled") return { step: "failed", busy: false, error: e.code };
		return s.step === "approved" || s.step === "cancelled" || s.step === "failed" ? s : { ...s, busy: false, error: e.code };
	}
	switch (s.step) {
		case "idle":
			if (e.type === "start") return s.busy ? s : { ...s, busy: true, error: undefined };
			if (e.type === "shown") return { step: "showing", pairingId: e.pairingId, qr: e.qr, text: e.text, busy: false };
			return s;
		case "showing":
			if (e.type === "reviewed") return { step: "review", pairingId: s.pairingId, deviceName: e.name, code: e.code, busy: false };
			if (e.type === "reject") return { step: "cancelled", busy: false };
			return s;
		case "review":
			if (e.type === "approve") return s.busy ? s : { ...s, busy: true, error: undefined };
			if (e.type === "approved") return { step: "approved", busy: false, deviceName: s.deviceName };
			if (e.type === "reject") return s.busy ? s : { step: "cancelled", busy: false };
			return s;
		default:
			return s;
	}
}

// ---------------------------------------------------------------- joiner

export type JoinerState =
	| ({ step: "choose" } & Common)
	| ({ step: "showing"; pairingId: string; qr: string; text: string; code: string } & Common)
	| ({ step: "scan"; value: string } & Common)
	| ({ step: "waiting"; pairingId: string; code: string } & Common)
	| { step: "done"; busy: false }
	| { step: "failed"; busy: false; error: string };

export type JoinerEvent =
	| { type: "show_own" }
	| { type: "shown"; pairingId: string; qr: string; text: string; code: string }
	| { type: "scan_mode" }
	| { type: "value_changed"; value: string }
	| { type: "join" }
	| { type: "joined"; pairingId: string; code: string }
	| { type: "finished" }
	| { type: "failed"; code: string };

export const initialJoiner: JoinerState = { step: "choose", busy: false };

/** The approver's code, as pasted: a `lhv1-pair:` QR payload. Text-only codes need the pairing id, so the UI takes the full payload. */
export function looksLikePairingPayload(s: string): boolean {
	return s.trim().startsWith("lhv1-pair:");
}

export function reduceJoiner(s: JoinerState, e: JoinerEvent): JoinerState {
	if (e.type === "failed") {
		if (s.step === "done" || s.step === "failed") return s;
		if (e.code === "pairing_timeout" || e.code === "pairing_cancelled") return { step: "failed", busy: false, error: e.code };
		return { ...s, busy: false, error: e.code } as JoinerState;
	}
	switch (s.step) {
		case "choose":
			if (e.type === "show_own") return s.busy ? s : { ...s, busy: true, error: undefined };
			if (e.type === "shown") return { step: "showing", pairingId: e.pairingId, qr: e.qr, text: e.text, code: e.code, busy: false };
			if (e.type === "scan_mode") return { step: "scan", value: "", busy: false };
			return s;
		case "scan":
			if (e.type === "value_changed") return { ...s, value: e.value, error: undefined };
			if (e.type === "join") return looksLikePairingPayload(s.value) ? (s.busy ? s : { ...s, value: s.value.trim(), busy: true, error: undefined }) : { ...s, error: "bad_code" };
			if (e.type === "joined") return { step: "waiting", pairingId: e.pairingId, code: e.code, busy: true };
			return s;
		case "showing":
			// the joiner already joined when it showed its code; the approver's approval completes it
			if (e.type === "finished") return { step: "done", busy: false };
			return s;
		case "waiting":
			if (e.type === "finished") return { step: "done", busy: false };
			return s;
		default:
			return s;
	}
}

/** Group a 6-digit code for reading aloud: "123 456". */
export function formatPairingCode(code: string): string {
	return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Group the 52-character text code in blocks of 4 for typing. */
export function formatPairingText(text: string): string {
	return text.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
