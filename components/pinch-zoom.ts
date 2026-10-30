/**
 * Two-finger pinch zoom for the pan/zoom overlays (owner Q66): the touch
 * twin of their wheel zoom. Reports each step's scale factor and the
 * pinch midpoint in the element's own coordinates; the caller applies it
 * with the shared viewport math (pan-zoom.ts zoomedGraphView).
 */
export function attachPinchZoom(el: HTMLElement, onZoom: (factor: number, focus: { x: number; y: number }) => void): () => void {
	let last: number | null = null;
	const spread = (e: TouchEvent) => {
		const [a, b] = [e.touches[0]!, e.touches[1]!];
		return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
	};
	const onStart = (e: TouchEvent) => {
		last = e.touches.length === 2 ? spread(e) : null;
	};
	const onMove = (e: TouchEvent) => {
		if (e.touches.length !== 2 || last === null) return;
		e.preventDefault(); // the page must not zoom or scroll under the pinch
		const now = spread(e);
		const rect = el.getBoundingClientRect();
		const [a, b] = [e.touches[0]!, e.touches[1]!];
		onZoom(now / last, { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top });
		last = now;
	};
	const onEnd = (e: TouchEvent) => {
		if (e.touches.length < 2) last = null;
	};
	el.addEventListener("touchstart", onStart, { passive: true });
	el.addEventListener("touchmove", onMove, { passive: false });
	el.addEventListener("touchend", onEnd, { passive: true });
	el.addEventListener("touchcancel", onEnd, { passive: true });
	return () => {
		el.removeEventListener("touchstart", onStart);
		el.removeEventListener("touchmove", onMove);
		el.removeEventListener("touchend", onEnd);
		el.removeEventListener("touchcancel", onEnd);
	};
}
