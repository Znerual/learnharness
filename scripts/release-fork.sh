#!/usr/bin/env bash
# Release this fork to Znerual/learnharness — the feed installed fork apps
# update from (electron-builder.yml publish, guarded by
# tests/fork-update-feed.test.ts). GitHub Actions builds the installers
# (.github/workflows/release.yml: Windows + Linux, and an ad-hoc signed
# macOS build — owner, 2026-11-01).
#
#   1. Bump package.json "version" (upstream + fork counter, see
#      docs/desktop-release.md) and commit it on main.
#   2. scripts/release-fork.sh           tag + push; Actions builds one draft
#   3. scripts/release-fork.sh publish   after the "Desktop release" run
#                                        passes: notes + publish the draft
set -euo pipefail

cd "$(dirname "$0")/.."
OWNER=Znerual
REPO=learnharness
VERSION=$(node -p 'require("./package.json").version')
TAG="v$VERSION"
# The upstream base: the patch is (upstream patch + 1) × 1000 + counter.
BASE=$(node -p 'const v=require("./package.json").version.split("."); v[0]+"."+v[1]+"."+(Math.floor(v[2]/1000)-1)')

export GH_TOKEN
GH_TOKEN=$(gh auth token --user "$OWNER")

if [[ "${1:-}" == publish ]]; then
	run=$(gh run list --repo "$OWNER/$REPO" --workflow release.yml --branch "$TAG" --limit 1 --json status,conclusion,url \
		-q '.[0] | "\(.status) \(.conclusion) \(.url)"')
	[[ "$run" == "completed success "* ]] || { echo "the Desktop release run for $TAG has not passed: ${run:-no run}"; exit 1; }
	gh release edit "$TAG" --repo "$OWNER/$REPO" --draft=false --title "LearnHarness $VERSION (fork)" --notes "Fork build of upstream $BASE with this fork's features — see the README's \"This fork\" section.

- Windows (x64): unsigned installer; Windows may show a SmartScreen warning.
- Linux (x64): AppImage or .deb.
- macOS (Apple Silicon): ad-hoc signed, not notarized — allow it under System Settings → Privacy & Security. Updates on macOS: download the new version.

Windows and Linux update in the app."
	echo "published $TAG → https://github.com/$OWNER/$REPO/releases/tag/$TAG"
	exit 0
fi

[[ "$(git branch --show-current)" == main ]] || { echo "release from main"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean"; exit 1; }
git remote get-url fork >/dev/null 2>&1 || { echo "no 'fork' remote (https://github.com/$OWNER/$REPO.git)"; exit 1; }
if gh release view "$TAG" --repo "$OWNER/$REPO" >/dev/null 2>&1; then
	echo "$TAG already exists — bump the fork counter in package.json first"
	exit 1
fi
npm run typecheck
npm run lint

git tag -a "$TAG" -m "LearnHarness fork $VERSION"
# HTTPS with the Znerual token: the machine's SSH key belongs to another account.
git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
	push fork main "$TAG"
echo "pushed $TAG — GitHub Actions now builds the draft:"
echo "  https://github.com/$OWNER/$REPO/actions/workflows/release.yml"
echo "then: scripts/release-fork.sh publish"
