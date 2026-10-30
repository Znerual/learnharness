/**
 * GET /api/busy — is this device's server working (a turn, a job, an
 * extraction)? The Android shell polls it to run its foreground service
 * only while work is in progress (multi-device, step 4).
 *
 *   GET → 200 {busy: boolean}
 */
import { deviceBusy } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ busy: deviceBusy() });
}
