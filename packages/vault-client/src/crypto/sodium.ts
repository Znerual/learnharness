// Loads libsodium once. Every crypto module imports `sodium` from here.
import sodiumModule from "libsodium-wrappers";

await sodiumModule.ready;

export const sodium = sodiumModule;
