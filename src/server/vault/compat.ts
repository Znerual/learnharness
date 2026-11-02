// Compile-time proof that the real vault client still satisfies the structural types the routes use
// (routes.ts keeps no runtime import of the client so it can be tested against a fake Vault).
// Nothing runs. If the client's API drifts, `npm run typecheck` fails here. Without the package
// the types come from client-shim.d.ts, where `any` passes every check below.

import type { JoinerPairing, SyncEngine, Vault } from "@znerual/learnharness-vault-client";
import type { SyncStatus } from "../../core/vault/deps.ts";
import type { JoinerLike, VaultLike, VaultStatics } from "./routes.ts";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Fits<A, B> = IsAny<A> extends true ? true : A extends B ? true : false;
type Assert<T extends true> = T;

export type RealVaultIsVaultLike = Assert<Fits<Vault, VaultLike>>;
export type RealStaticsAreVaultStatics = Assert<Fits<typeof Vault, VaultStatics>>;
export type RealJoinerIsJoinerLike = Assert<Fits<JoinerPairing, JoinerLike>>;
export type RealEngineStatus = Assert<Fits<ReturnType<SyncEngine["status"]>, SyncStatus>>;
