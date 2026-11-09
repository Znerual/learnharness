/**
 * THE BUILT-IN VOICES (owner, 2026-11-09): OmniVoice has no named voices, so
 * each preset is a voice description ("instruct") plus a fixed seed, which
 * keeps the voice the same from block to block. AudioAgent's OmniVoice voices
 * use the same four ids and descriptions, so a chosen voice id describes the
 * same voice on both engines (the sound differs a little: another runtime and
 * random generator). Every preset reads English and German.
 */

export interface OmniVoicePreset {
	id: string;
	instruct: string;
	seed: number;
}

export const OMNIVOICE_PRESETS: readonly OmniVoicePreset[] = [
	{ id: "omni-female-low", instruct: "female, middle-aged, low pitch", seed: 1001 },
	{ id: "omni-female-high", instruct: "female, young adult, high pitch", seed: 1002 },
	{ id: "omni-male-low", instruct: "male, middle-aged, low pitch", seed: 1003 },
	{ id: "omni-male-moderate", instruct: "male, young adult, moderate pitch", seed: 1004 },
];

/** The voice a request without one gets. */
export const OMNIVOICE_DEFAULT_PRESET = OMNIVOICE_PRESETS[0]!;

export function omniVoicePreset(id: string): OmniVoicePreset | null {
	return OMNIVOICE_PRESETS.find((p) => p.id === id) ?? null;
}
