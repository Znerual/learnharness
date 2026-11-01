"use client";

import type { EmergencyKit as Kit } from "@/src/core";
import { formatDate } from "@/src/core";
import { strings } from "@/src/core";
import { Button, QrSvg, SecretBlock } from "./ui.tsx";

const PRINT_CSS = `
@media print {
	body * { visibility: hidden !important; }
	[data-print-area], [data-print-area] * { visibility: visible !important; }
	[data-print-area] { position: absolute; inset: 0; padding: 24mm; color: #000; background: #fff; }
	[data-no-print] { display: none !important; }
}`;

/**
 * Printable emergency kit (ADR 0005): email, server address and the recovery key as text and QR
 * code. Created on this device, never uploaded. "Print" opens the browser print dialog, which
 * can also save a PDF; no PDF library is involved. Render this only on the one-time screens.
 */
export function EmergencyKit({ kit, onPrint }: { kit: Kit; onPrint?: () => void }) {
	return (
		<section data-testid="emergency-kit" className="flex flex-col gap-3">
			<style>{PRINT_CSS}</style>
			<div data-print-area="true" className="flex flex-col gap-3">
				<h2 className="text-lg font-semibold">{strings.kit.title}</h2>
				<p className="text-sm">{strings.kit.intro}</p>
				<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
					<dt className="font-medium">{strings.kit.email}</dt>
					<dd data-testid="kit-email">{kit.email}</dd>
					<dt className="font-medium">{strings.kit.server}</dt>
					<dd data-testid="kit-server">{kit.serverUrl}</dd>
				</dl>
				<SecretBlock testid="kit-recovery-key" label={strings.kit.recoveryKey} value={kit.recoveryKey} />
				<QrSvg value={kit.recoveryKeyQr} label={strings.kit.qr} />
				<p className="text-xs">{strings.kit.created(formatDate(kit.createdAt))}</p>
				<p className="text-xs">{strings.kit.howTo}</p>
			</div>
			<div data-no-print="true">
				<Button
					onClick={() => {
						onPrint?.();
						if (typeof window !== "undefined") window.print();
					}}
				>
					{strings.kit.print}
				</Button>
			</div>
		</section>
	);
}
