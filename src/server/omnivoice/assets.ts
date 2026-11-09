/**
 * THE BUILT-IN VOICE ENGINE'S DOWNLOADS (owner, 2026-11-09): what "On this
 * computer (OmniVoice)" fetches, pinned by size and SHA-256. Nothing here
 * ships with the app; the user starts the download in Settings → Read aloud.
 *
 * - The engine: omnivoice-rs (FerrisMind, Apache-2.0), a Rust/Candle port of
 *   OmniVoice with an OpenAI-compatible server, release b42. GPU only: the
 *   CPU path measured RTF ~11 (owner's laptop, 2026-11-09), far slower than
 *   speech. Linux and Windows run the CUDA build; macOS on Apple silicon runs
 *   the Metal build.
 * - The CUDA libraries it links (cuBLAS, cuBLASLt, cuRAND) come from NVIDIA's
 *   own Python wheels on PyPI, not from the release's CUDA 12.6 `cudart-`
 *   archive (owner, 2026-11-09): cuBLAS 12.6 has no Blackwell (RTX 50) kernels
 *   and read about twice as slow as playback there; 12.9 fixes that, and works
 *   on older NVIDIA GPUs too. Only the libraries are unpacked from a wheel.
 * - The model: k2-fsa/OmniVoice at a pinned Hugging Face revision. Its
 *   weights are CC BY-NC 4.0 (non-commercial); the audio tokenizer has Boson
 *   AI's Higgs Audio 2 community license. Settings shows both before the
 *   download.
 */

export interface OmniVoiceFile {
	url: string;
	/** Where it lands, relative to the engine folder. */
	path: string;
	bytes: number;
	sha256: string;
	/** An archive is unpacked into `extractTo` (relative to the engine folder) and deleted. */
	extractTo?: string;
	/** Zip only (a wheel): just these files, flat into `extractTo`. Without it the system's tar unpacks everything. */
	pick?: readonly string[];
}

export type OmniVoiceDevice = "cuda" | "metal";

export interface OmniVoicePlatform {
	/** "linux-x64", "win32-x64", "darwin-arm64". */
	id: string;
	device: OmniVoiceDevice;
	/** The server binary, relative to the engine folder. */
	server: string;
	/** The engine archive, plus the CUDA runtime archive on CUDA platforms. */
	files: OmniVoiceFile[];
	/** The folder holding the CUDA libraries (CUDA platforms), relative to the engine folder. */
	libraries?: string;
}

export const OMNIVOICE_RELEASE = "b42";
const RELEASE_URL = `https://github.com/FerrisMind/omnivoice-rs/releases/download/${OMNIVOICE_RELEASE}`;

function archive(name: string, bytes: number, sha256: string, extractTo: string): OmniVoiceFile {
	return { url: `${RELEASE_URL}/${name}`, path: `downloads/${name}`, bytes, sha256, extractTo };
}

/** Where the CUDA libraries land, named by the cuBLAS version. */
const CUDA_LIBRARIES = "cuda-cublas-12.9.1.4";

/** One of NVIDIA's wheels on PyPI: only `pick` is unpacked. */
function wheel(url: string, bytes: number, sha256: string, pick: readonly string[]): OmniVoiceFile {
	return { url, path: `downloads/${url.slice(url.lastIndexOf("/") + 1)}`, bytes, sha256, extractTo: CUDA_LIBRARIES, pick };
}

export const OMNIVOICE_PLATFORMS: readonly OmniVoicePlatform[] = [
	{
		id: "linux-x64",
		device: "cuda",
		server: `engine-${OMNIVOICE_RELEASE}/omnivoice-${OMNIVOICE_RELEASE}/omnivoice-server`,
		files: [
			archive(`omnivoice-${OMNIVOICE_RELEASE}-bin-ubuntu-cuda-12.6-x64.tar.gz`, 42_122_171, "375ddd0ac4aa62fc1ede4057aaa970a4eb2d7c12bbf527427e3caec04672e624", `engine-${OMNIVOICE_RELEASE}`),
			wheel(
				"https://files.pythonhosted.org/packages/77/3c/aa88abe01f3be3d1f8f787d1d33dc83e76fec05945f9a28fbb41cfb99cd5/nvidia_cublas_cu12-12.9.1.4-py3-none-manylinux_2_27_x86_64.whl",
				581_242_350,
				"453611eb21a7c1f2c2156ed9f3a45b691deda0440ec550860290dc901af5b4c2",
				["libcublas.so.12", "libcublasLt.so.12"],
			),
			wheel(
				"https://files.pythonhosted.org/packages/31/44/193a0e171750ca9f8320626e8a1f2381e4077a65e69e2fb9708bd479e34a/nvidia_curand_cu12-10.3.10.19-py3-none-manylinux_2_27_x86_64.whl",
				68_295_626,
				"49b274db4780d421bd2ccd362e1415c13887c53c214f0d4b761752b8f9f6aa1e",
				["libcurand.so.10"],
			),
		],
		libraries: CUDA_LIBRARIES,
	},
	{
		id: "win32-x64",
		device: "cuda",
		server: `engine-${OMNIVOICE_RELEASE}/omnivoice-${OMNIVOICE_RELEASE}/omnivoice-server.exe`,
		files: [
			archive(`omnivoice-${OMNIVOICE_RELEASE}-bin-win-cuda-12.6-x64.zip`, 15_701_744, "7da47a2aa9f2f9958a1ba95986bb71a5c8bf40ccc71e0da2e3bca76d9e79b7c4", `engine-${OMNIVOICE_RELEASE}`),
			wheel(
				"https://files.pythonhosted.org/packages/45/a1/a17fade6567c57452cfc8f967a40d1035bb9301db52f27808167fbb2be2f/nvidia_cublas_cu12-12.9.1.4-py3-none-win_amd64.whl",
				553_153_899,
				"1e5fee10662e6e52bd71dec533fbbd4971bb70a5f24f3bc3793e5c2e9dc640bf",
				["cublas64_12.dll", "cublasLt64_12.dll"],
			),
			wheel(
				"https://files.pythonhosted.org/packages/e5/98/1bd66fd09cbe1a5920cb36ba87029d511db7cca93979e635fd431ad3b6c0/nvidia_curand_cu12-10.3.10.19-py3-none-win_amd64.whl",
				68_774_847,
				"e8129e6ac40dc123bd948e33d3e11b4aa617d87a583fa2f21b3210e90c743cde",
				["curand64_10.dll"],
			),
		],
		libraries: CUDA_LIBRARIES,
	},
	{
		id: "darwin-arm64",
		device: "metal",
		server: `engine-${OMNIVOICE_RELEASE}/omnivoice-${OMNIVOICE_RELEASE}/omnivoice-server`,
		files: [
			archive(`omnivoice-${OMNIVOICE_RELEASE}-bin-macos-arm64.tar.gz`, 11_313_727, "4a489b6c1b837e581a6c27d46b865c05f8fdef2decbd9640d59a7308f484c950", `engine-${OMNIVOICE_RELEASE}`),
		],
	},
];

export const OMNIVOICE_MODEL_REVISION = "c5fdb5ccb189668d56333f77ba2629f4cd7535f4";
/** The model folder, relative to the engine folder. */
export const OMNIVOICE_MODEL_DIR = `model-${OMNIVOICE_MODEL_REVISION.slice(0, 8)}`;
const MODEL_URL = `https://huggingface.co/k2-fsa/OmniVoice/resolve/${OMNIVOICE_MODEL_REVISION}`;

function modelFile(name: string, bytes: number, sha256: string): OmniVoiceFile {
	return { url: `${MODEL_URL}/${name}`, path: `${OMNIVOICE_MODEL_DIR}/${name}`, bytes, sha256 };
}

export const OMNIVOICE_MODEL_FILES: readonly OmniVoiceFile[] = [
	modelFile("config.json", 2238, "5e359117e13b420c5e0c925d4aba650d624767131f1d1746928f8b850d5dc372"),
	modelFile("chat_template.jinja", 4168, "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8"),
	modelFile("tokenizer.json", 11_423_986, "408f669b7e2b045fdf54201d815bd364e6667dbd845115da81239c40bc6dcfd1"),
	modelFile("tokenizer_config.json", 533, "49f78845596a82bf15c83673794bdf9f76f812b11f60ab6a2239d9be65b00676"),
	modelFile("model.safetensors", 2_450_344_112, "730839316de585f4c8298ec0e1712efc10fb19c6fa4e36eb741cb8d51ebcf6aa"),
	modelFile("audio_tokenizer/config.json", 2531, "eefb20806f7104e77c9a5277c9df0f9bb8826b08eb1d4e8ab2b9829b6ef9fac1"),
	modelFile("audio_tokenizer/preprocessor_config.json", 206, "ae61eea88558608ee2fa86d2aec9fce8d99a5ff75d09cb7651ccce21ae1d9084"),
	modelFile("audio_tokenizer/LICENSE", 9171, "ac933dc084d119bd20401956b90d11ae87c248b2da62622cd580d82cdf2fa049"),
	modelFile("audio_tokenizer/model.safetensors", 805_665_628, "fe7c5e8785e0a05833e1bfc3e002ec7f55af21e306b2e7154a448c1f54ccfb0d"),
];

/** The licenses Settings shows before the download. */
export const OMNIVOICE_LICENSES = {
	model: { name: "CC BY-NC 4.0 (non-commercial)", url: "https://huggingface.co/k2-fsa/OmniVoice" },
	audioTokenizer: { name: "Boson Higgs Audio 2 Community License", url: `https://huggingface.co/k2-fsa/OmniVoice/blob/${OMNIVOICE_MODEL_REVISION}/audio_tokenizer/LICENSE` },
	engine: { name: "Apache-2.0", url: "https://github.com/FerrisMind/omnivoice-rs" },
	cuda: { name: "NVIDIA CUDA libraries (NVIDIA's license)", url: "https://docs.nvidia.com/cuda/eula/index.html" },
} as const;

export function omniVoicePlatform(platform: string = process.platform, arch: string = process.arch): OmniVoicePlatform | null {
	return OMNIVOICE_PLATFORMS.find((p) => p.id === `${platform}-${arch}`) ?? null;
}

/** Every file a platform downloads, engine first. */
export function omniVoiceFiles(platform: OmniVoicePlatform): OmniVoiceFile[] {
	return [...platform.files, ...OMNIVOICE_MODEL_FILES];
}
