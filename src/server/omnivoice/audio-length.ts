/**
 * How long a voice clip's recording is (owner, 2026-11-09: 3–10 s), read from
 * the file itself: WAV from its header, MP3 by walking its frames. Pure and
 * dependency-free, so the check runs before anything is stored.
 */

export type AudioKind = "wav" | "mp3";

/** Seconds of audio, or null when the bytes are not a WAV or MP3 it can read. */
export function audioSeconds(bytes: Uint8Array): { kind: AudioKind; seconds: number } | null {
	const wav = wavSeconds(bytes);
	if (wav !== null) return { kind: "wav", seconds: wav };
	const mp3 = mp3Seconds(bytes);
	if (mp3 !== null) return { kind: "mp3", seconds: mp3 };
	return null;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(at, at + length));
}

export function wavSeconds(bytes: Uint8Array): number | null {
	if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let byteRate = 0;
	let at = 12;
	while (at + 8 <= bytes.length) {
		const id = ascii(bytes, at, 4);
		const size = view.getUint32(at + 4, true);
		if (id === "fmt " && at + 16 <= bytes.length) byteRate = view.getUint32(at + 16, true);
		if (id === "data") {
			if (!byteRate) return null;
			// A streamed WAV may carry 0 or 0xFFFFFFFF here: then the rest of the file is the data.
			const dataBytes = size === 0 || size === 0xffffffff ? bytes.length - at - 8 : Math.min(size, bytes.length - at - 8);
			return dataBytes / byteRate;
		}
		at += 8 + size + (size % 2);
	}
	return null;
}

// MPEG audio frame header tables (versions 1, 2 and 2.5; layers I–III).
const BITRATES: Record<string, number[]> = {
	"1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
	"1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
	"1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
	"2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
	"2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
	"2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

export function mp3Seconds(bytes: Uint8Array): number | null {
	let at = 0;
	// An ID3v2 tag in front: 10-byte header, then a syncsafe size.
	if (bytes.length >= 10 && ascii(bytes, 0, 3) === "ID3") {
		at = 10 + (((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f));
	}
	let seconds = 0;
	let frames = 0;
	while (at + 4 <= bytes.length) {
		const b1 = bytes[at + 1]!;
		const b2 = bytes[at + 2]!;
		if (bytes[at] !== 0xff || (b1 & 0xe0) !== 0xe0) {
			if (frames > 0) break; // trailing tag or junk after the audio
			at++;
			continue;
		}
		const versionBits = (b1 >> 3) & 3;
		const layerBits = (b1 >> 1) & 3;
		const bitrateIndex = b2 >> 4;
		const rateIndex = (b2 >> 2) & 3;
		if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
			if (frames > 0) break;
			at++;
			continue;
		}
		const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
		const layer = 4 - layerBits;
		const bitrate = BITRATES[`${version === 1 ? 1 : 2}-${layer}`]![bitrateIndex]! * 1000;
		const rate = SAMPLE_RATES[version]![rateIndex]!;
		const padding = (b2 >> 1) & 1;
		const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
		const length = layer === 1 ? (Math.floor((12 * bitrate) / rate) + padding) * 4 : Math.floor((samples / 8) * bitrate / rate) + padding;
		if (length < 4) break;
		seconds += samples / rate;
		frames++;
		at += length;
	}
	return frames >= 2 ? seconds : null;
}
