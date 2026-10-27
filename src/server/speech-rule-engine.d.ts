// speech-rule-engine ships no types — the slice src/server/math-speech.ts uses.
declare module "speech-rule-engine" {
	interface SpeechRuleEngine {
		/** `custom` replaces the engine's locale file loader (locale → JSON). */
		setupEngine(options: Record<string, string | ((locale: string) => Promise<string>)>): Promise<void>;
		engineReady(): Promise<void>;
		toSpeech(mathml: string): string;
		/** Where the engine reads a locale's rule file (lib/mathmaps/<locale>.json). */
		localePath(locale: string): string;
	}
	const sre: SpeechRuleEngine;
	export default sre;
}
