/** Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		// Custom endpoints re-detect their models once per start, in the
		// background: an offline start keeps the stored lists.
		void import("./src/server/custom-provider-http.ts")
			.then(({ redetectCustomProviders }) => redetectCustomProviders())
			.catch((error) => console.error("[custom-providers] Startup re-detect failed:", error));
		const { initializePlugins } = await import("./src/server/plugins.ts");
		try { await initializePlugins(); }
		catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
	}
}
