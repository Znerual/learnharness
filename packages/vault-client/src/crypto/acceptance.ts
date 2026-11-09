// Key acceptance rules of ADR 0002: commitment check on unlock, rotation acceptance,
// no generation rollback, and pkTag checks before every seal.

import { type Bytes, bytesEqual } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import { checkCounter, type MethodKind, vkName } from "./framing.ts";
import { generateKey, unwrapKey, wipe, wrapKey } from "./keys.ts";
import { type BoxKeyPair, openRootKey, sealRootKey, verifyCommitment, verifyPkTag } from "./unlock.ts";

/** Keys a device holds after unlock. */
export interface KeySet {
	readonly accountId: string;
	readonly generation: number;
	readonly rootKey: Bytes;
	readonly ik: Bytes;
	/** VK_1..VK_epoch, index 0 is epoch 1. */
	readonly vaultKeys: readonly Bytes[];
}

export function currentEpoch(keys: KeySet): number {
	return keys.vaultKeys.length;
}

export function vaultKeyFor(keys: KeySet, epoch: number): Bytes | undefined {
	return keys.vaultKeys[epoch - 1];
}

export interface Wrap {
	readonly name: string;
	readonly wrap: Bytes;
}

/** The generation and epoch a device has accepted so far (rule 3). */
export interface HighWater {
	readonly generation: number;
	readonly epoch: number;
}

function wrapByName(wraps: readonly Wrap[], name: string): Bytes {
	const matches = wraps.filter((w) => w.name === name);
	if (matches.length !== 1) throw new ProtocolError("bad_format", `expected exactly one wrap named ${name}`);
	return (matches[0] as Wrap).wrap;
}

/** Unwraps IK and VK_1..VK_epoch under a root key. */
export function unwrapAll(accountId: string, generation: number, rootKey: Bytes, epoch: number, wraps: readonly Wrap[]): { ik: Bytes; vaultKeys: Bytes[] } {
	checkCounter(epoch, "epoch");
	const ik = unwrapKey(rootKey, generation, accountId, "ik", wrapByName(wraps, "ik"));
	const vaultKeys: Bytes[] = [];
	for (let e = 1; e <= epoch; e++) vaultKeys.push(unwrapKey(rootKey, generation, accountId, vkName(e), wrapByName(wraps, vkName(e))));
	return { ik, vaultKeys };
}

export interface UnlockInput {
	readonly accountId: string;
	/** The account's current generation and epoch as the server reports them. */
	readonly generation: number;
	readonly epoch: number;
	readonly wraps: readonly Wrap[];
	readonly method: { readonly kind: MethodKind; readonly publicKey: Bytes; readonly sealed: Bytes; readonly commit: Bytes | null };
	readonly seed: Bytes;
	readonly keyPair: BoxKeyPair;
	/** What this device accepted before, if anything. */
	readonly highWater?: HighWater | undefined;
}

/**
 * Opens a sealed root key with an unlock method and accepts it only if the key commitment
 * matches (rule 1, rule 6) and the generation and epoch are not lower than accepted before (rule 3).
 */
export function unlock(input: UnlockInput): KeySet {
	if (!bytesEqual(input.method.publicKey, input.keyPair.publicKey)) throw new ProtocolError("foreign_key", "The unlock method's public key does not match the derived key pair");
	if (!input.method.commit) throw new ProtocolError("no_commitment", "This unlock method has no key commitment and cannot unlock");
	const { generation, rootKey } = openRootKey(input.method.sealed, input.keyPair);
	if (generation !== input.generation) throw new ProtocolError("bad_format", `sealed root key is for generation ${generation}, server says ${input.generation}`);
	if (input.highWater && (generation < input.highWater.generation || input.epoch < input.highWater.epoch)) {
		throw new ProtocolError("rollback", `The server offered generation ${generation}, epoch ${input.epoch}, but this device already accepted generation ${input.highWater.generation}, epoch ${input.highWater.epoch}`);
	}
	const { ik, vaultKeys } = unwrapAll(input.accountId, generation, rootKey, input.epoch, input.wraps);
	verifyCommitment(input.method.commit, input.seed, input.accountId, input.method.kind, input.method.publicKey, ik);
	return { accountId: input.accountId, generation, rootKey, ik, vaultKeys };
}

/**
 * Rule 2: accept ARK_{g'} only if g' > g and its wraps return the same IK and VK_1..VK_e plus
 * at least one new vault key.
 */
export function acceptRotation(current: KeySet, newGeneration: number, newRootKey: Bytes, newEpoch: number, wraps: readonly Wrap[]): KeySet {
	if (newGeneration < current.generation) throw new ProtocolError("rollback", `generation ${newGeneration} is lower than accepted generation ${current.generation}`);
	if (newGeneration === current.generation) {
		if (bytesEqual(newRootKey, current.rootKey)) return current;
		throw new ProtocolError("rotation_rejected", "A different root key with the same generation was offered");
	}
	const oldEpoch = currentEpoch(current);
	if (newEpoch <= oldEpoch) throw new ProtocolError("rotation_rejected", "The rotation adds no vault key");
	let unwrapped: { ik: Bytes; vaultKeys: Bytes[] };
	try {
		unwrapped = unwrapAll(current.accountId, newGeneration, newRootKey, newEpoch, wraps);
	} catch (e) {
		throw new ProtocolError("rotation_rejected", `The rotation's wraps do not open: ${(e as Error).message}`);
	}
	if (!bytesEqual(unwrapped.ik, current.ik)) throw new ProtocolError("rotation_rejected", "The rotation changed the index key");
	for (let e = 1; e <= oldEpoch; e++) {
		if (!bytesEqual(unwrapped.vaultKeys[e - 1] as Bytes, current.vaultKeys[e - 1] as Bytes)) throw new ProtocolError("rotation_rejected", `The rotation changed ${vkName(e)}`);
	}
	return { accountId: current.accountId, generation: newGeneration, rootKey: newRootKey, ik: current.ik, vaultKeys: unwrapped.vaultKeys };
}

/** A method row as the server lists it, for sealing. */
export interface MethodForSeal {
	readonly id: string;
	readonly kind: MethodKind;
	readonly publicKey: Bytes;
	readonly pkTag: Bytes;
}

export interface Seal {
	readonly methodId: string;
	readonly sealed: Bytes;
}

/** Checks pkTag (rule 5) and the device's pins, then seals the root key to each method. */
export function sealToMethods(keys: KeySet, methods: readonly MethodForSeal[], pinned?: ReadonlyMap<string, Bytes>): Seal[] {
	for (const m of methods) {
		verifyPkTag(m.pkTag, keys.ik, keys.accountId, m.kind, m.publicKey);
		const pin = pinned?.get(m.id);
		if (pin && !bytesEqual(pin, m.publicKey)) throw new ProtocolError("pk_tag_mismatch", `The public key of unlock method ${m.id} changed since this device verified it`);
	}
	return methods.map((m) => ({ methodId: m.id, sealed: sealRootKey(keys.generation, keys.rootKey, m.publicKey) }));
}

export interface Rotation {
	readonly next: KeySet;
	readonly wraps: Wrap[];
	readonly seals: Seal[];
}

/**
 * Builds the next generation (ADR 0006 steps 1 to 3): new ARK and VK, re-wrap IK and every
 * vault key, verify and seal to `remaining` methods.
 */
export function buildRotation(current: KeySet, remaining: readonly MethodForSeal[], pinned?: ReadonlyMap<string, Bytes>): Rotation {
	const generation = current.generation + 1;
	const rootKey = generateKey();
	const vaultKeys = [...current.vaultKeys, generateKey()];
	const next: KeySet = { accountId: current.accountId, generation, rootKey, ik: current.ik, vaultKeys };
	const wraps = wrapAllKeys(next);
	const seals = sealToMethods(next, remaining, pinned);
	return { next, wraps, seals };
}

/** Wraps IK and VK_1..VK_e under the key set's root key. */
export function wrapAllKeys(keys: KeySet): Wrap[] {
	const wraps: Wrap[] = [{ name: "ik", wrap: wrapKey(keys.rootKey, keys.generation, keys.accountId, "ik", keys.ik) }];
	keys.vaultKeys.forEach((vk, i) => wraps.push({ name: vkName(i + 1), wrap: wrapKey(keys.rootKey, keys.generation, keys.accountId, vkName(i + 1), vk) }));
	return wraps;
}

/** A brand-new account key set: generation 1, epoch 1. */
export function newAccountKeys(accountId: string): KeySet {
	return { accountId, generation: 1, rootKey: generateKey(), ik: generateKey(), vaultKeys: [generateKey()] };
}

export function wipeKeySet(keys: KeySet): void {
	wipe(keys.rootKey, keys.ik, ...keys.vaultKeys);
}
