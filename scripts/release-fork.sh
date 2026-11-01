#!/usr/bin/env bash
# Build and publish a Linux release of this fork to Znerual/learnharness —
# the feed installed fork apps update from (electron-builder.yml publish,
# guarded by tests/fork-update-feed.test.ts).
#
#   1. Bump package.json "version" (upstream + fork counter: 0.3.6001, …)
#      and commit it on main.
#   2. scripts/release-fork.sh
#
# Builds the standalone server, smoke-tests it in Electron's Node, packages
# AppImage + deb, checks the baked update feed, pushes main + the tag to
# the `fork` remote, and publishes a GitHub release with the updater feed
# (latest-linux.yml) as the Znerual account.
set -euo pipefail

cd "$(dirname "$0")/.."
OWNER=Znerual
REPO=learnharness
VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"

[[ "$(git branch --show-current)" == main ]] || { echo "release from main"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean"; exit 1; }
git remote get-url fork >/dev/null 2>&1 || { echo "no 'fork' remote (https://github.com/$OWNER/$REPO.git)"; exit 1; }
export GH_TOKEN
GH_TOKEN=$(gh auth token --user "$OWNER")
if gh release view "$TAG" --repo "$OWNER/$REPO" >/dev/null 2>&1; then
	echo "$TAG is already released — bump the fork counter in package.json first"
	exit 1
fi

rm -rf dist .next/standalone
npm run build
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron
npx electron-builder --linux --x64 --publish never
git checkout -- next-env.d.ts 2>/dev/null || true

# The packaged app must update from the fork, never from upstream.
FEED=dist/linux-unpacked/resources/app-update.yml
grep -q "owner: $OWNER" "$FEED" && grep -q "repo: $REPO" "$FEED" || { echo "unexpected update feed in $FEED:"; cat "$FEED"; exit 1; }

git tag -a "$TAG" -m "LearnHarness fork $VERSION"
# HTTPS with the Znerual token: the machine's SSH key belongs to another account.
git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
	push fork main "$TAG"
gh release create "$TAG" --repo "$OWNER/$REPO" --title "LearnHarness $VERSION (fork)" \
	--notes "Fork build of upstream $(node -p 'const v=require("./package.json").version.split("."); v[0]+"."+v[1]+"."+(Math.floor(v[2]/1000)-1)') with this fork's features. Linux x64." \
	"dist/LearnHarness-$VERSION-x86_64.AppImage" "dist/LearnHarness-$VERSION-amd64.deb" dist/latest-linux.yml
echo "released $TAG → https://github.com/$OWNER/$REPO/releases/tag/$TAG"
