// QR code to SVG. The matrix comes from the `qrcode` package (pinned); the SVG is built here so
// the output is one <path> with no external styles and works in server-side rendering.

import QRCode from "qrcode";

export interface QrMatrix {
	size: number;
	/** Row-major, true = dark module. */
	modules: boolean[];
}

export function qrMatrix(text: string, errorCorrection: "L" | "M" | "Q" | "H" = "M"): QrMatrix {
	const q = QRCode.create(text, { errorCorrectionLevel: errorCorrection });
	const size = q.modules.size;
	const modules: boolean[] = [];
	for (let i = 0; i < size * size; i++) modules.push(q.modules.data[i] === 1);
	return { size, modules };
}

/** SVG path data for the dark modules, one rectangle per horizontal run. */
export function qrPath(m: QrMatrix): string {
	const parts: string[] = [];
	for (let y = 0; y < m.size; y++) {
		let x = 0;
		while (x < m.size) {
			if (!m.modules[y * m.size + x]) {
				x++;
				continue;
			}
			const start = x;
			while (x < m.size && m.modules[y * m.size + x]) x++;
			parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
		}
	}
	return parts.join("");
}

export const QR_QUIET_ZONE = 4;
