/**
 * Build-time stand-in for @znerual/learnharness-vault-client when the package is not installed:
 * next.config.ts aliases the package to this file (turbopack.resolveAlias), because Turbopack
 * fails the build on an import it cannot resolve. Evaluating it throws the same error Node
 * gives for a missing package, which src/server/vault/service.ts catches (isMissingPackage) and
 * reports as "vault unavailable". It is never evaluated unless LH_VAULT_URL is set.
 */

throw Object.assign(new Error("Cannot find package '@znerual/learnharness-vault-client' (optional dependency not installed)"), { code: "ERR_MODULE_NOT_FOUND" });

// Named exports only so the bundler can link the importers; unreachable.
export const Vault = undefined;
export const SyncEngine = undefined;
export const Restorer = undefined;
export const MemoryKeyStorage = undefined;
export const KeyStorageError = undefined;
export const FsHost = undefined;
export const decodeBundle = undefined;
export const encodeBundle = undefined;
export const leaveVault = undefined;
export const checkPassword = undefined;
export const parseLedgerFile = undefined;
export const isDocumentPath = undefined;
export const crypto = undefined;
