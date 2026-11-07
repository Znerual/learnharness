#!/usr/bin/env bash
# Build the vault macOS app on a Mac: the LearnHarness desktop app with a vault server built in, for
# the vault host's download page. The Mac fetches the code itself (the repo is public, no login):
#
#   curl -fsSLO https://raw.githubusercontent.com/Znerual/learnharness/main/scripts/vault-mac-build.sh
#   bash vault-mac-build.sh --version 0.4.2111
#
# or, from a checkout, scripts/vault-mac-build.sh --version 0.4.2111 --here.
#
# Options:
#   --version X.Y.Z   required; the same number as the Linux and Android vault builds of the release
#   --host NAME       vault host built in as https://NAME (default learn-vault.ddns.net)
#   --ref REF         branch or tag to build (default main); ignored with --here
#   --dir DIR         where the build checkout lives (default ~/learnharness-vault-mac); cloned on the
#                     first run, reset to origin/REF on every later run (local changes there are refused)
#   --here            build the checkout this script is in, as it is (the GitHub workflow uses this)
#   --out DIR         where the result goes (default <checkout>/dist-vault)
#   --copy-to TARGET  scp the result there afterwards, e.g. laurenz@build-pc.local:lhv-mac/
#
# Result in --out: learnharness-macos.dmg and version.txt, the shape learnharness-vault's
# deploy/lan/release-vault-build.sh takes (--mac-dmg DIR), so the DMG is published together with the
# Linux and Android builds of the same version.
#
# Needs: Apple Silicon, macOS 26+ and Xcode 26+ (actool compiles the Icon Composer icon,
# build/icon.icon), Node 26 with npm, git. The app is ad-hoc signed and not notarized (no Apple
# Developer ID): macOS asks the user to allow it on first launch. Squirrel.Mac cannot update an
# ad-hoc signed app, so in-app updates are off in this build; the download page offers new versions.
set -euo pipefail

REPO_URL="https://github.com/Znerual/learnharness.git"
version="" host="learn-vault.ddns.net" ref="main" dir="$HOME/learnharness-vault-mac" here="" out="" copy_to=""

fail() { echo "vault-mac-build: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
	case "$1" in
		--version) version="${2:-}"; shift 2 ;;
		--host) host="${2:-}"; shift 2 ;;
		--ref) ref="${2:-}"; shift 2 ;;
		--dir) dir="${2:-}"; shift 2 ;;
		--here) here=1; shift ;;
		--out) out="${2:-}"; shift 2 ;;
		--copy-to) copy_to="${2:-}"; shift 2 ;;
		-h | --help) sed -n '2,30p' "$0"; exit 0 ;;
		*) fail "unknown option: $1 (see --help)" ;;
	esac
done

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "--version must be plain X.Y.Z (got '$version')"
[[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || fail "--host must be a bare host name (got '$host')"
[[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "--ref has unexpected characters: $ref"

# ── the machine ───────────────────────────────────────────────────────────────
[ "$(uname -s)" = Darwin ] || fail "this builds the macOS app and runs only on a Mac"
[ "$(uname -m)" = arm64 ] || fail "needs Apple Silicon (the app is built for arm64)"
macos="$(sw_vers -productVersion)"
[ "${macos%%.*}" -ge 26 ] || fail "needs macOS 26 or newer for the app icon (actool); this Mac runs $macos"
# The icon compile needs Xcode's actool, not the Command Line Tools alone.
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
	export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
xcode="$(xcodebuild -version 2>/dev/null | sed -n 's/^Xcode //p' || true)"
[ -n "$xcode" ] || fail "needs Xcode 26+ (install it from the App Store, open it once, or set DEVELOPER_DIR)"
[ "${xcode%%.*}" -ge 26 ] || fail "needs Xcode 26 or newer for actool; found Xcode $xcode"
command -v git >/dev/null || fail "needs git"
command -v node >/dev/null && command -v npm >/dev/null || fail "needs Node 26 with npm (nodejs.org, or brew install node@26)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 26 ] || fail "needs Node 26 or newer (the release builds use 26); found $(node -v)"
echo "== Mac: macOS $macos, Xcode $xcode, Node $(node -v)"

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

# The packaged app reads learnharnessBuild from its package.json (electron/main.cjs). The edit is
# undone afterwards, whatever happens, so the checkout stays clean.
saved="$(mktemp)"
cp package.json "$saved"
restore() { cp "$saved" package.json; rm -f "$saved"; }
trap restore EXIT
VERSION="$version" VAULT_URL="https://$host" node -e '
	const fs = require("node:fs");
	const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
	pkg.version = process.env.VERSION;
	pkg.learnharnessBuild = { vaultUrl: process.env.VAULT_URL, autoUpdate: false };
	fs.writeFileSync("package.json", JSON.stringify(pkg, null, "\t") + "\n");
'

rm -rf dist .next/standalone
echo "== next build ($version, vault https://$host)"
# Settings → General shows this number and links "Release notes" to the vault host's page.
LH_BUILD_VERSION="$version" LH_RELEASE_NOTES_URL="https://$host/releases/" NEXT_TELEMETRY_DISABLED=1 npm run build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron
echo "== package (ad-hoc signed, not notarized)"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --publish never -c.mac.identity=- -c.mac.notarize=false

app="dist/mac-arm64/LearnHarness.app/Contents"
node scripts/smoke-provider-runtime.mjs --standalone "$app/Resources/server/standalone"
node scripts/smoke-provider-runtime.mjs --standalone "$app/Resources/server/standalone" --runtime "$app/MacOS/LearnHarness"

# ── check what was packaged ───────────────────────────────────────────────────
check="$(mktemp -d)"
(cd "$check" && npx --yes @electron/asar@3.4.1 extract-file "$checkout/$app/Resources/app.asar" package.json)
PACKAGED="$check/package.json" VERSION="$version" VAULT_URL="https://$host" node -e '
	const pkg = JSON.parse(require("node:fs").readFileSync(process.env.PACKAGED, "utf8"));
	const b = pkg.learnharnessBuild ?? {};
	if (pkg.version !== process.env.VERSION) throw new Error(`packaged version ${pkg.version}, expected ${process.env.VERSION}`);
	if (b.vaultUrl !== process.env.VAULT_URL || b.autoUpdate !== false) throw new Error(`packaged learnharnessBuild ${JSON.stringify(b)}`);
	console.log("packaged:", pkg.version, JSON.stringify(b));
'
rm -rf "$check"

shopt -s nullglob
dmgs=(dist/*.dmg)
[ "${#dmgs[@]}" -eq 1 ] || fail "expected one DMG in dist/, found: ${dmgs[*]:-none}"
mkdir -p "$out"
cp "${dmgs[0]}" "$out/learnharness-macos.dmg"
echo "$version" > "$out/version.txt"
echo "== result in $out"
shasum -a 256 "$out/learnharness-macos.dmg"

if [ -n "$copy_to" ]; then
	echo "== copying to $copy_to"
	scp "$out/learnharness-macos.dmg" "$out/version.txt" "$copy_to"
fi
echo "built vault macOS $version"
