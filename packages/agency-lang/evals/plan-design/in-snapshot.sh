#!/usr/bin/env bash
# Runs any agent command inside this repository as it was at a test's commit.
#
# usage, as an --agent-cmd:
#   evals/plan-design/in-snapshot.sh <agent command...>
#
# The eval framework starts this script in the run's workdir, where the test
# has seeded a `snapshot-commit` file holding one commit hash. The script
# unpacks packages/agency-lang at that commit under $PLAN_DESIGN_SNAPSHOTS,
# once, makes it read-only, changes into it, and runs the rest of its
# arguments there. The agent reads the old code and cannot change it, so
# every trial sees the same files.
set -euo pipefail

if [ -z "${PLAN_DESIGN_SNAPSHOTS:-}" ]; then
  echo "Set PLAN_DESIGN_SNAPSHOTS to an absolute path outside the repository." >&2
  exit 1
fi
if [ ! -f snapshot-commit ]; then
  echo "No snapshot-commit file in $(pwd). The test must seed one." >&2
  exit 1
fi

commit="$(tr -d '[:space:]' < snapshot-commit)"
case "$commit" in
  *[!0-9a-f]* | "")
    echo "snapshot-commit must hold a full lowercase commit hash, got: $commit" >&2
    exit 1
    ;;
esac
target="$PLAN_DESIGN_SNAPSHOTS/$commit"

if [ ! -d "$target" ]; then
  repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
  mkdir -p "$PLAN_DESIGN_SNAPSHOTS"
  # Unpacked beside the target and renamed, so a trial never reads a
  # half-unpacked snapshot. Each process unpacks into a folder of its own.
  partial="$target.partial.$$"
  mkdir "$partial"
  git -C "$repo_root" archive "$commit" packages/agency-lang | tar -x -C "$partial"
  chmod -R a-w "$partial/packages"
  # Another trial may have finished first. Its copy is the same, so use it.
  # This script deletes nothing: the spare copy stays for a person to remove.
  if ! mv "$partial" "$target" 2>/dev/null; then
    echo "Another trial unpacked $commit first. A spare copy is at $partial." >&2
  fi
fi

cd "$target/packages/agency-lang"
exec "$@"
