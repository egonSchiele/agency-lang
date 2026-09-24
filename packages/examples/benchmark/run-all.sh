#!/usr/bin/env bash
# Benchmark several models, one at a time, then compare them.
#
#   ./run-all.sh gpt-5.4-mini claude-haiku-4-5 local:qwen3.5-2b
#   BENCH_ARGS="--trials 5 --cases latency,toolChain" ./run-all.sh gpt-5.4-mini local:qwen3.5-2b
#
# Write a hosted model as its plain name, or as provider/model when the name
# alone is not enough (openrouter/qwen/qwen3-32b). A bare OpenAI name such as
# gpt-5.4-mini is sent to the openai-responses provider. Write a local model as
# local:<name>, using any name `agency run --local` accepts: a curated name,
# an alias, an hf: URI, a .gguf path, or an mlx: URI. An MLX model needs
# `agency local serve` running in another terminal first.
#
# With no arguments, the models in DEFAULT_MODELS below are used.
#
# Each model's results go to results/<name>.json, and its progress to
# results/<name>.log. The models run one after another rather than all at
# once, so a local model gets the whole machine and hosted timings are not
# skewed by sharing a rate limit.
#
# Environment variables:
#   BENCH_ARGS   extra flags for run-model.agency, such as --trials 5 (the default is 3)
#   RESULTS_DIR  where result files go (default: results)
#   LOCAL_MAX_TOKENS  cap on output tokens per call for local models, thinking
#                included (default: 30000). The llama.cpp context holds 32768
#                tokens, prompt and output together, so going higher gains
#                little. Hosted models keep their provider's default.
#   AGENCY       how to run agency (default: the examples package's own copy,
#                or agency on your PATH if that is missing)

set -uo pipefail

cd "$(dirname "$0")"

DEFAULT_MODELS=(gpt-5.4-mini claude-haiku-4-5 gemini-3.8-flash local:qwen3.5-2b)
if [ -z "${AGENCY:-}" ]; then
  if [ -x ../node_modules/.bin/agency ]; then
    AGENCY=../node_modules/.bin/agency
  else
    AGENCY=agency
  fi
fi
RESULTS_DIR="${RESULTS_DIR:-results}"
BENCH_ARGS="${BENCH_ARGS:-}"
LOCAL_MAX_TOKENS="${LOCAL_MAX_TOKENS:-30000}"

if [ $# -gt 0 ]; then
  models=("$@")
else
  models=("${DEFAULT_MODELS[@]}")
fi

mkdir -p "$RESULTS_DIR"

files=()
failed=()
for entry in "${models[@]}"; do
  if [[ "$entry" == local:* ]]; then
    name="${entry#local:}"
    model_flag=(--local "$name")
    # The default cap is 16384, which a small thinking model can use up
    # before it answers.
    cap_flag=(--max-tokens "$LOCAL_MAX_TOKENS")
  else
    name="$entry"
    model_flag=(--model "$name")
    cap_flag=()
    # The catalog routes OpenAI models to the "openai" provider, which is
    # the older chat completions API. Some cases fail there, so a bare
    # OpenAI name goes to "openai-responses" instead. A name that already
    # says its provider (openai/gpt-5.4-mini) is left alone.
    case "$name" in
      */*) ;;
      gpt-*|o[0-9]*) model_flag=(--model "openai-responses/$name") ;;
    esac
  fi
  # "mlx:mlx-community/Qwen3.8-27B-4bit" becomes "mlx_mlx-community_Qwen3.8-27B-4bit".
  safe="$(printf '%s' "$name" | tr '/:' '__')"
  out="$RESULTS_DIR/$safe.json"
  log="$RESULTS_DIR/$safe.log"

  echo "=== $name ==="
  # Remove the old file, so a failed run cannot leave stale results that
  # look new.
  rm -f "$out"
  # BENCH_ARGS is left unquoted on purpose, so it splits into separate flags.
  # cap_flag is written as ${a[@]+"${a[@]}"} because macOS's bash 3.2, under
  # set -u, treats an empty array as an unset variable.
  # shellcheck disable=SC2086
  $AGENCY run "${model_flag[@]}" run-model.agency --label "$name" --out "$out" ${cap_flag[@]+"${cap_flag[@]}"} $BENCH_ARGS 2>&1 | tee "$log"

  if [ -f "$out" ]; then
    files+=("$out")
  else
    failed+=("$name")
  fi
  echo
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "No results for: ${failed[*]} (see the .log files in $RESULTS_DIR)"
fi

if [ ${#files[@]} -eq 0 ]; then
  echo "Nothing to compare."
  exit 1
fi

$AGENCY run compare.agency "${files[@]}" --out "$RESULTS_DIR/combined.json"
