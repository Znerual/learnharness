// Passkey ceremony page. Runs on https://<vault host> (intercepted by passkey-window.cjs).
// Gets {op, options, prfSalt} from the main process, runs create/get with the PRF extension and
// hands {credential, prfOutput} back. Registration needs a PRF output for the unlock method; when
// create() does not return one (most authenticators only report prf.enabled), it asks for one
// extra assertion on the new credential, which costs the learner one more touch.
"use strict";

const b64uToBytes = (s) => {
	const p = s.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const bytesToB64u = (buf) => {
	const b = new Uint8Array(buf);
	let s = "";
	for (const x of b) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const descriptors = (list) => (list || []).map((d) => ({ ...d, id: b64uToBytes(d.id) }));

function toRequestOptions(pk, salt) {
	const o = { ...pk, challenge: b64uToBytes(pk.challenge) };
	if (pk.allowCredentials) o.allowCredentials = descriptors(pk.allowCredentials);
	o.extensions = { ...(pk.extensions || {}), prf: { eval: { first: salt } } };
	return o;
}

function toCreationOptions(pk, salt) {
	const o = { ...pk, challenge: b64uToBytes(pk.challenge), user: { ...pk.user, id: b64uToBytes(pk.user.id) } };
	if (pk.excludeCredentials) o.excludeCredentials = descriptors(pk.excludeCredentials);
	o.extensions = { ...(pk.extensions || {}), prf: { eval: { first: salt } } };
	return o;
}

/** WebAuthn JSON (what the server expects), without relying on PublicKeyCredential.toJSON. */
function credentialJson(c) {
	const r = c.response;
	const response = { clientDataJSON: bytesToB64u(r.clientDataJSON) };
	if (r.attestationObject) {
		response.attestationObject = bytesToB64u(r.attestationObject);
		if (r.getTransports) response.transports = r.getTransports();
	} else {
		response.authenticatorData = bytesToB64u(r.authenticatorData);
		response.signature = bytesToB64u(r.signature);
		if (r.userHandle) response.userHandle = bytesToB64u(r.userHandle);
	}
	const ext = c.getClientExtensionResults();
	return {
		id: c.id, rawId: bytesToB64u(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment || undefined,
		response, clientExtensionResults: ext,
	};
}

const prfOf = (c) => c.getClientExtensionResults().prf?.results?.first;

async function run(req) {
	const salt = b64uToBytes(req.prfSalt);
	if (req.op === "get") {
		const c = await navigator.credentials.get({ publicKey: toRequestOptions(req.options, salt) });
		const first = prfOf(c);
		return { credential: credentialJson(c), prfOutput: first ? bytesToB64u(first) : null, prfEnabled: !!first };
	}
	const c = await navigator.credentials.create({ publicKey: toCreationOptions(req.options, salt) });
	const prf = c.getClientExtensionResults().prf;
	let first = prfOf(c);
	if (!first && prf && prf.enabled) {
		document.getElementById("status").textContent = "Touch your passkey once more";
		const a = await navigator.credentials.get({
			publicKey: toRequestOptions({ challenge: bytesToB64u(crypto.getRandomValues(new Uint8Array(32))), rpId: req.options.rp.id, userVerification: "required", allowCredentials: [{ type: "public-key", id: bytesToB64u(c.rawId) }] }, salt),
		});
		first = prfOf(a);
	}
	return { credential: credentialJson(c), prfOutput: first ? bytesToB64u(first) : null, prfEnabled: !!(prf && prf.enabled) || !!first };
}

(async () => {
	const status = document.getElementById("status");
	try {
		const req = await window.lhPasskey.request();
		if (!req) { status.textContent = "No ceremony pending"; return; }
		const value = await run(req);
		status.textContent = "Done";
		await window.lhPasskey.finish({ ok: true, ...value });
	} catch (e) {
		status.textContent = "Passkey was not used";
		await window.lhPasskey.finish({ ok: false, error: { name: e && e.name || "Error", message: String(e && e.message || e).slice(0, 200) } });
	}
})();
