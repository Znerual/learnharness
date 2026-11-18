#!/usr/bin/env bash
# Build the vault Linux app on a Linux PC: the LearnHarness desktop app with a vault server built in,
# from the public source. The vault host's download page shows the one-liner for its current version,
# which fetches this script and builds at the release tag vault-<version> (learnharness-vault's
# deploy/lan/release-vault-build.sh pushes it), e.g.:
#
#   curl -fsSLO https://raw.githubusercontent.com/Znerual/learnharness/vault-0.6.2103/scripts/vault-linux-build.sh && bash vault-linux-build.sh --version 0.6.2103 --ref vault-0.6.2103
#
# or, from a checkout, scripts/vault-linux-build.sh --version 0.6.2103 --here.
# The full guide is docs/build/linux.md.
#
# Options:
#   --version X.Y.Z   required; the version of the vault release being built
#   --host NAME       vault host built in as https://NAME (default learn-vault.ddns.net)
#   --ref REF         branch or tag to build (default main); ignored with --here
#   --dir DIR         where the build checkout lives (default ~/learnharness-vault-linux); cloned on
#                     the first run, reset to origin/REF on every later run (local changes there are
#                     refused)
#   --here            build the checkout this script is in, as it is
#   --out DIR         where the result goes (default <checkout>/dist-vault)
#   --deb             also build the .deb package (Debian, Ubuntu and derivatives)
#   --no-updates      turn in-app updates off; without it the app updates itself from the vault
#                     host's feed https://NAME/updates/, that is to the published builds
#
# Result in --out: learnharness-linux.AppImage, with --deb also learnharness-linux.deb, and
# version.txt.
#
# Needs: Linux on x64, Node 26 with npm, git, and about 10 GB of free disk space.
set -euo pipefail

REPO_URL="https://github.com/Znerual/learnharness.git"
version="" host="learn-vault.ddns.net" ref="main" dir="$HOME/learnharness-vault-linux" here="" out="" deb="" updates=1

fail() { echo "vault-linux-build: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--version) version="${2:-}"; shift 2 ;;
		--host) host="${2:-}"; shift 2 ;;
		--ref) ref="${2:-}"; shift 2 ;;
		--dir) dir="${2:-}"; shift 2 ;;
		--here) here=1; shift ;;
		--out) out="${2:-}"; shift 2 ;;
		--deb) deb=1; shift ;;
		--no-updates) updates=""; shift ;;
		-h | --help) sed -n '2,28p' "$0"; exit 0 ;;
		*) fail "unknown option: $1 (see --help)" ;;
	esac
done

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "--version must be plain X.Y.Z (got '$version')"
[[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || fail "--host must be a bare host name (got '$host')"
[[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "--ref has unexpected characters: $ref"

# ── the machine ───────────────────────────────────────────────────────────────
[ "$(uname -s)" = Linux ] || fail "this builds the Linux app and runs only on Linux"
[ "$(uname -m)" = x86_64 ] || fail "needs an x64 PC (the app is built for x64); this one is $(uname -m)"
command -v git >/dev/null || fail "needs git (for example: sudo apt install git)"
command -v node >/dev/null && command -v npm >/dev/null || fail "needs Node 26 with npm (see docs/build/linux.md)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 26 ] || fail "needs Node 26 or newer (the release builds use 26); found $(node -v)"
echo "== Linux: $(uname -r), Node $(node -v)"

# ── the code ──────────────────────────────────────────────────────────────────
if [ -n "$here" ]; then
	checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
	[ -f "$checkout/electron/main.cjs" ] || fail "--here: $checkout is not a learnharness checkout"
	echo "== code: this checkout ($checkout, $(git -C "$checkout" rev-parse --short HEAD 2>/dev/null || echo 'no git'))"
else
	checkout="$dir"
	if [ ! -d "$checkout/.git" ]; then
		echo "== code: cloning $REPO_URL into $checkout"
		git clone --quiet "$REPO_URL" "$checkout"
	fi
	[ -z "$(git -C "$checkout" status --porcelain --untracked-files=no)" ] ||
		fail "$checkout has local changes; it is a build checkout, reset it (git -C '$checkout' checkout -- .) or pass another --dir"
	git -C "$checkout" fetch --quiet --tags --force origin
	if git -C "$checkout" rev-parse --verify --quiet "refs/remotes/origin/$ref" >/dev/null; then
		git -C "$checkout" checkout --quiet --detach "origin/$ref"
	else
		git -C "$checkout" checkout --quiet --detach "$ref" 2>/dev/null || fail "no branch or tag '$ref' in $REPO_URL"
	fi
	echo "== code: $ref at $(git -C "$checkout" rev-parse --short HEAD)"
fi
out="${out:-$checkout/dist-vault}"
cd "$checkout"

# ── build ─────────────────────────────────────────────────────────────────────
echo "== npm ci"
npm ci --no-audit --no-fund
echo "== plugins:setup"
npm run plugins:setup

rm -rf dist .next/standalone
echo "== next build ($version, vault https://$host)"
# Settings → General shows this number and links "Release notes" to the vault host's page.
LH_BUILD_VERSION="$version" LH_RELEASE_NOTES_URL="https://$host/releases/" NEXT_TELEMETRY_DISABLED=1 npm run build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron

targets=(AppImage)
[ -z "$deb" ] || targets+=(deb)
# The packaged app reads learnharnessBuild from its package.json (electron/main.cjs); extraMetadata
# sets it there without touching the checkout, as release-vault-build.sh does.
meta=(-c.extraMetadata.version="$version" -c.extraMetadata.learnharnessBuild.vaultUrl="https://$host")
if [ -n "$updates" ]; then
	meta+=(-c.extraMetadata.learnharnessBuild.updateFeed="https://$host/updates/")
	echo "== package (${targets[*]}, update feed https://$host/updates/)"
else
	meta+=(-c.extraMetadata.learnharnessBuild.autoUpdate=false)
	echo "== package (${targets[*]}, in-app updates off)"
fi
npx electron-builder --linux "${targets[@]}" --x64 --publish never "${meta[@]}"

unpacked="dist/linux-unpacked"
node scripts/smoke-provider-runtime.mjs --standalone "$unpacked/resources/server/standalone"
node scripts/smoke-provider-runtime.mjs --standalone "$unpacked/resources/server/standalone" --runtime "$unpacked/learnharness"

# ── check what was packaged ───────────────────────────────────────────────────
check="$(mktemp -d)"
(cd "$check" && npx --yes @electron/asar@3.4.1 extract-file "$checkout/$unpacked/resources/app.asar" package.json)
PACKAGED="$check/package.json" VERSION="$version" VAULT_URL="https://$host" UPDATES="$updates" node -e '
	const pkg = JSON.parse(require("node:fs").readFileSync(process.env.PACKAGED, "utf8"));
	const b = pkg.learnharnessBuild ?? {};
	if (pkg.version !== process.env.VERSION) throw new Error(`packaged version ${pkg.version}, expected ${process.env.VERSION}`);
	const updatesOk = process.env.UPDATES
		? b.updateFeed === `${process.env.VAULT_URL}/updates/` && b.autoUpdate !== false
		: b.autoUpdate === false && b.updateFeed === undefined;
	if (b.vaultUrl !== process.env.VAULT_URL || !updatesOk) throw new Error(`packaged learnharnessBuild ${JSON.stringify(b)}`);
	console.log("packaged:", pkg.version, JSON.stringify(b));
'
rm -rf "$check"

# ── result ────────────────────────────────────────────────────────────────────
shopt -s nullglob
appimages=(dist/LearnHarness-"$version"-*.AppImage)
[ "${#appimages[@]}" -eq 1 ] || fail "expected one AppImage in dist/, found: ${appimages[*]:-none}"
mkdir -p "$out"
rm -f "$out/learnharness-linux.AppImage" "$out/learnharness-linux.deb"
cp "${appimages[0]}" "$out/learnharness-linux.AppImage"
chmod +x "$out/learnharness-linux.AppImage"
if [ -n "$deb" ]; then
	debs=(dist/LearnHarness-"$version"-*.deb)
	[ "${#debs[@]}" -eq 1 ] || fail "expected one .deb in dist/, found: ${debs[*]:-none}"
	cp "${debs[0]}" "$out/learnharness-linux.deb"
fi
echo "$version" > "$out/version.txt"
echo "== result in $out"
(cd "$out" && sha256sum learnharness-linux.*)
echo "built vault Linux $version"
echo "Run $out/learnharness-linux.AppImage, or see docs/build/linux.md for installing it."
