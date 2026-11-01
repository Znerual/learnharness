/** One custom endpoint: discover/manual connect (POST), offline pins, thinking
 * format and name (PATCH), and disconnect (DELETE). Host boundaries and
 * mutations live behind the server barrel. */
import { customProviderGet, customProviderMutation } from "@/src/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
const handle = async (request: Request, { params }: Context) => customProviderMutation(request, (await params).id);
export async function GET(request: Request, { params }: Context) {
	return customProviderGet(request, (await params).id);
}
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
