#!/usr/bin/env bash
# The --agent-cmd for the agency-agent suite: runs `agency agent` inside the
# eval image with the run directory mounted at its own absolute path.
#
# The eval framework starts this script in the run's workdir/ and hands it
# AGENCY_CONFIG_OVERRIDES (holding the host path of the statelog to write,
# under the sibling agent/) and AGENCY_TRACE_ID. Mounting the run directory
# at the same path inside the container keeps that statelog path valid, so
# grading reads the agent's output as usual. Everything after the script name
# goes to `agency agent` untouched; the framework substitutes {input} before
# this script sees argv, one argv entry per token, so no shell parsing here.
set -euo pipefail

IMAGE="${AGENCY_EVAL_IMAGE:-agency-eval}"
NETWORK="${AGENCY_EVAL_NETWORK:-bridge}"

workdir="$(pwd -P)"
rundir="$(dirname "$workdir")"

exec docker run --rm \
  -v "$rundir:$rundir" \
  -w "$workdir" \
  -e AGENCY_CONFIG_OVERRIDES \
  -e AGENCY_TRACE_ID \
  -e ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY \
  --network "$NETWORK" \
  "$IMAGE" \
  agency agent "$@"
