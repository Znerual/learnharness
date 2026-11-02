import type { ReauthMethod } from "@/src/core";
import { strings } from "@/src/core";

export const reauthMethodsLabel: Record<ReauthMethod, string> = {
	password: strings.reauth.withPassword,
	passkey: strings.reauth.withPasskey,
	recovery: strings.reauth.withRecovery,
};
