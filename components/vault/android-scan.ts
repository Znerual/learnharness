// The Android app's camera QR scanner, as the page sees it (components/vault/Pairing.tsx).
// The page calls `window.LHAndroid.scanPairingCode()`; the app answers by calling
// `window.lhAndroidPairScan({ ok, payload, reason })` (reason: 0 cancelled, 2 permission denied,
// 3 no camera). Same pattern as `lhAndroidBack`. The payload is a `lhv1-pair:` string the page hands
// to the server like a pasted code. Nothing here exists outside the app: callers get null.

export interface AndroidPairScanResult {
	ok: boolean;
	payload?: string;
	reason?: number;
}

type Bridge = { scanPairingCode?: () => void };
type Win = typeof window & { LHAndroid?: Bridge; lhAndroidPairScan?: (r: AndroidPairScanResult) => void };

/** Whether this page runs inside the Android app with a pairing scanner. */
export function androidScannerAvailable(): boolean {
	return typeof window !== "undefined" && typeof (window as Win).LHAndroid?.scanPairingCode === "function";
}

/** Opens the scanner and routes its single answer to `onResult`. Returns a function that stops listening. */
export function startAndroidScan(onResult: (r: AndroidPairScanResult) => void): () => void {
	const w = window as Win;
	const bridge = w.LHAndroid;
	const handler = (r: AndroidPairScanResult) => {
		if (w.lhAndroidPairScan === handler) delete w.lhAndroidPairScan;
		onResult(r);
	};
	w.lhAndroidPairScan = handler;
	try {
		bridge?.scanPairingCode?.();
	} catch {
		delete w.lhAndroidPairScan;
		onResult({ ok: false, reason: -1 });
	}
	return () => {
		if (w.lhAndroidPairScan === handler) delete w.lhAndroidPairScan;
	};
}
