/** A touch-first device (owner Q61/Q64): a phone or tablet whose primary
 *  pointer is a finger. Client-only — false while rendering on the server,
 *  which is fine for autoFocus (React applies it on the client only). */
export function isCoarsePointer(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}
