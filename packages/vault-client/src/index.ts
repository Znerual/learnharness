export * from "./api/client.ts";
export type * from "./api/types.ts";
export * as crypto from "./crypto/index.ts";
export * from "./keystorage.ts";
export * from "./passwords.ts";
export * from "./restore.ts";
export * from "./sync/engine.ts";
export * from "./sync/host.ts";
export * from "./sync/mapping.ts";
export * from "./vault.ts";

/** Version of the vault client package. */
export const clientVersion = "0.3.0";
