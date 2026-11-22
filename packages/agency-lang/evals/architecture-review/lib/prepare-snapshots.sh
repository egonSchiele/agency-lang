#!/bin/bash
# Unpack the repository at every commit the suite's tests name, so the
# reviewer reads the code as it was when each plan was written.
#
# usage: ARCH_REVIEW_SNAPSHOTS=/abs/path bash lib/prepare-snapshots.sh
#
# Each snapshot holds only packages/agency-lang (about 65 MB) and is
# skipped when it already exists.
set -euo pipefail

if [ -z "${ARCH_REVIEW_SNAPSHOTS:-}" ]; then
  echo "Set ARCH_REVIEW_SNAPSHOTS to an absolute path." >&2
  exit 1
fi

suite_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(git -C "$suite_dir" rev-parse --show-toplevel)"
mkdir -p "$ARCH_REVIEW_SNAPSHOTS"

for test_json in "$suite_dir"/*/test.json; do
  commit="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).input.commit)' "$test_json")"
  target="$ARCH_REVIEW_SNAPSHOTS/$commit"
  if [ -d "$target" ]; then
    continue
  fi
  mkdir -p "$target.partial"
  git -C "$repo_root" archive "$commit" packages/agency-lang | tar -x -C "$target.partial"
  mv "$target.partial" "$target"
  echo "unpacked $commit"
done
