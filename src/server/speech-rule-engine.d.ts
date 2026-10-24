// speech-rule-engine ships no types — the slice src/server/tts.ts uses.
declare module "speech-rule-engine" {
	interface SpeechRuleEngine {
		setupEngine(options: Record<string, string>): Promise<void>;
		engineReady(): Promise<void>;
		toSpeech(mathml: string): string;
	}
	const sre: SpeechRuleEngine;
	export default sre;
}
