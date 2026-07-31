#!/usr/bin/env bash
# One fix-git eval run against the agency agent.
#
#   run.sh [provider] [model]
#
# Copies the fixture into a fresh workdir, runs the one-shot code agent there
# with the same invocation the terminal-bench adapter uses, captures the
# statelog, grades the result, then summarizes the statelog.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDER="${1:-anthropic}"
MODEL="${2:-claude-opus-4-8}"

INSTRUCTION="I just made some changes to my personal site and checked out master, but now I can't find those changes. Please help me find them and merge them into master."

[ -d "$HERE/fixture/personal-site" ] || "$HERE/build-fixture.sh"

RUN="$HERE/runs/$(date +%Y%m%d-%H%M%S)-$$"   # pid suffix avoids same-second collisions
mkdir -p "$RUN"
cp -R "$HERE/fixture/personal-site" "$RUN/workdir"   # $RUN/workdir IS the repo
STATELOG="$RUN/statelog.jsonl"

echo "== run: provider=$PROVIDER model=$MODEL =="
echo "   workdir:  $RUN/workdir"
echo "   statelog: $STATELOG"
echo ""
( cd "$RUN/workdir" && agency agent --agent code --policy approve-all -p \
    --provider "$PROVIDER" --model "$MODEL" \
    --max-tool-call-rounds 100 \
    --log "$STATELOG" -- "$INSTRUCTION" ) | tee "$RUN/transcript.txt"

echo ""; echo "== grade =="
node "$HERE/grade.mjs" "$RUN/workdir" || true

echo ""; echo "== statelog facts (agency eval extract) =="
if agency eval extract "$STATELOG" -o "$RUN/eval-record.json" >/dev/null 2>&1; then
  node "$HERE/summarize-record.mjs" "$RUN/eval-record.json" || true
else
  echo "  (eval extract failed — statelog at $STATELOG)"
fi

echo ""; echo "run dir: $RUN"
