/** PR #62's custom endpoint, one per entry of the customProviders list
 * (custom-endpoints wave): GET lists every endpoint's status, POST adds one
 * (its id comes from its name). Host boundaries and mutations live behind
 * the server barrel. */
import { customProviderCreate, customProvidersList } from "@/src/server";

export const dynamic = "force-dynamic";
export const GET = customProvidersList;
export const POST = customProviderCreate;
