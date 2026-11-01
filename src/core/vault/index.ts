// Renderer-safe entry point: view models, strings, the route contract and the API client.
// Components are imported from "./components/<Name>.tsx"; server routes from "./routes.ts"
// (Node only: it uses Buffer and runs in the LearnHarness server process).

export * from "./models/index.ts";
export { strings, errorText } from "./strings.ts";
export { routeTable, type VaultContract, type RouteName, type SessionDto, type RotationDto, type AccountDto, type PasskeyAvailabilityDto, type PasskeyRow } from "./contract.ts";
export { createVaultApi, errorCode, VaultApiError, type VaultApi } from "./api.ts";
export * from "./format.ts";
export type * from "./deps.ts";
