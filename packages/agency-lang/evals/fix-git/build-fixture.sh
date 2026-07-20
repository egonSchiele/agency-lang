#!/usr/bin/env bash
# Build the fix-git eval fixture: a git repo whose recent work survives only as
# a dangling commit, so the agent must recover it with `git reflog` / `git fsck`.
#
# This reproduces the original terminal-bench setup.sh dance. The two changed
# files are committed onto a detached HEAD, then master is checked out, which
# leaves the work unreferenced.
#
# Source of the base history is a local bundle (personal-site.bundle). The first
# run clones it from GitHub and caches the bundle; later runs are offline and
# deterministic. Both the bundle and the generated fixture are gitignored, so
# only the recipe is committed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$HERE/fixture/personal-site"
BUNDLE="$HERE/personal-site.bundle"
UPSTREAM="https://github.com/TheMikeMerrill/personal-site.git"

# Cache the base history as a bundle on first run (needs network once).
if [ ! -f "$BUNDLE" ]; then
  echo "No bundle found; cloning $UPSTREAM once to cache it..."
  TMP="$(mktemp -d)"
  git clone --quiet "$UPSTREAM" "$TMP/ps"
  git -C "$TMP/ps" bundle create "$BUNDLE" --all
  rm -rf "$TMP"
fi

rm -rf "$HERE/fixture"
mkdir -p "$HERE/fixture"

git clone --quiet "$BUNDLE" "$FIXTURE"
cd "$FIXTURE"

# A fixture repo needs an identity to commit; keep it local so the machine's
# global git config is left untouched.
git config user.email "test@example.com"
git config user.name "Test User"

git remote rm origin
git reset --hard d7d3e4b --quiet
git checkout --quiet HEAD~1              # the commit before the reset
cp "$HERE/gold/about.md" ./_includes/about.md
cp "$HERE/gold/default.html" ./_layouts/default.html
git add -A
git commit --quiet -m "Move to Stanford" # committed on a detached HEAD -> dangling
git checkout --quiet master

echo "Rebuilt fixture at $FIXTURE"
printf 'recoverable commit: '
git reflog --oneline | grep -i stanford || echo "  MISSING — rebuild failed"
