// The vault screens' primitives, over the fork's own components (components/ui/button.tsx,
// input.tsx). Plain elements keep a stable `data-testid`; colors use the fork's tokens.

import type { ComponentProps, InputHTMLAttributes, ReactNode } from "react";
import { Button as UiButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QR_QUIET_ZONE, qrMatrix, qrPath } from "./qr.ts";
import { errorText, strings, type PasswordFeedback } from "@/src/core";

type Variant = "primary" | "secondary" | "danger" | "link";
const VARIANT = { primary: "default", secondary: "outline", danger: "destructive", link: "link" } as const;

export function Button({ variant = "primary", size = "sm", ...props }: Omit<ComponentProps<typeof UiButton>, "variant"> & { variant?: Variant }) {
	return <UiButton type="button" variant={VARIANT[variant]} size={size} {...props} />;
}

export function Field({ label, help, error, children }: { label: string; help?: string; error?: string; children: ReactNode }) {
	return (
		<label className="flex flex-col gap-1 text-sm">
			<span className="font-medium">{label}</span>
			{children}
			{help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
			{error ? (
				<span role="alert" className="text-xs text-error">
					{error}
				</span>
			) : null}
		</label>
	);
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
	return <Input {...props} />;
}

/** Shows the message for an error code from a route or view model. */
export function ErrorLine({ code }: { code?: string | undefined }) {
	if (!code) return null;
	return (
		<p role="alert" data-testid="error" className="text-sm text-error">
			{errorText(code)}
		</p>
	);
}

export function Notice({ tone = "info", title, children, testid }: { tone?: "ok" | "info" | "warning" | "error"; title?: string; children?: ReactNode; testid?: string }) {
	const color = { ok: "border-success", info: "border-border", warning: "border-warning", error: "border-error" }[tone];
	return (
		<div role={tone === "error" ? "alert" : "status"} data-testid={testid} data-tone={tone} className={`rounded-md border-l-4 ${color} px-3 py-2 text-sm`}>
			{title ? <p className="font-medium">{title}</p> : null}
			{children}
		</div>
	);
}

export function RuleList({ feedback }: { feedback: PasswordFeedback }) {
	const mark = { ok: "✓", fail: "✗", pending: "…", neutral: "•" } as const;
	return (
		<ul data-testid="password-rules" className="flex flex-col gap-0.5 text-xs">
			{feedback.rules.map((r) => (
				<li key={r.id} data-rule={r.id} data-status={r.status} className={r.status === "fail" ? "text-error" : r.status === "ok" ? "text-success" : "text-muted-foreground"}>
					<span aria-hidden="true">{mark[r.status]} </span>
					{r.label}
					{r.detail ? <span className="block pl-4">{r.detail}</span> : null}
				</li>
			))}
		</ul>
	);
}

/** A secret the learner copies or writes down. Only the one-time screens render this. */
export function SecretBlock({ label, help, value, testid }: { label: string; help?: string; value: string | string[]; testid: string }) {
	const lines = Array.isArray(value) ? value : [value];
	return (
		<section data-testid={testid} data-secret="true" className="flex flex-col gap-1">
			<h3 className="text-sm font-medium">{label}</h3>
			{help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
			<ul className="font-mono text-sm leading-relaxed">
				{lines.map((l, i) => (
					<li key={i} className="select-all">
						{l}
					</li>
				))}
			</ul>
		</section>
	);
}

export function QrSvg({ value, size = 192, label = strings.qr.alt }: { value: string; size?: number; label?: string }) {
	const m = qrMatrix(value);
	const n = m.size + QR_QUIET_ZONE * 2;
	return (
		<svg role="img" aria-label={label} data-testid="qr" width={size} height={size} viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${n} ${n}`} shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
			<rect x={-QR_QUIET_ZONE} y={-QR_QUIET_ZONE} width={n} height={n} fill="#fff" />
			<path d={qrPath(m)} fill="#000" />
		</svg>
	);
}

export function Steps({ labels, index }: { labels: readonly string[]; index: number }) {
	return (
		<ol data-testid="steps" className="flex gap-2 text-xs text-muted-foreground">
			{labels.map((l, i) => (
				<li key={l} aria-current={i === index ? "step" : undefined} className={i === index ? "font-semibold text-foreground" : ""}>
					{i + 1}. {l}
				</li>
			))}
		</ol>
	);
}
