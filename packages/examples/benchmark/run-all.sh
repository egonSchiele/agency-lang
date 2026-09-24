#!/usr/bin/env bash
# Benchmark several models, one at a time, then compare them.
#
#   ./run-all.sh gpt-5.4-mini claude-haiku-4-5 local:qwen3.5-2b
#   HOSTED_TRIALS=5 BENCH_ARGS="--cases latency,toolChain" ./run-all.sh gpt-5.4-mini local:qwen3.5-2b
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
#   BENCH_ARGS   extra flags for run-model.agency, such as --cases extract,needle.
#                A flag this script sets itself (--trials, --max-tokens,
#                --timeout) is left to BENCH_ARGS when it is named there.
#   LOCAL_TRIALS how many times each case runs on a local model (default: 1;
#                the cases repeat their questions inside the call, so one
#                trial is enough, and a local run is the slow part)
#   HOSTED_TRIALS  the same for a hosted model (default: 3; a hosted run is
#                cheap, and sampling makes trials differ)
#   RESULTS_DIR  where result files go (default: results)
#   MAX_TOKENS   cap on output tokens per call, thinking included, for every
#                model (default: 8192). One cap for all is what makes the
#                comparison fair. Every honest reply seen so far fits: the
#                longest was a 4B thinking model at about 7300 tokens. A model
#                that talks itself in circles used to run to 30000, ten
#                minutes on a large model, before the run gave up on it. The
#                llama.cpp context holds 32768 tokens, prompt and output
#                together.
#   LOCAL_TIMEOUT  seconds to wait for one call to a local model (default:
#                300). Hosted models keep the runtime's ten minutes. Set it
#                to 0 for the runtime's default.
#   MACHINE_LABEL  a short name for this machine, such as m1-studio. It goes
#                into each results file and its name, so files from several
#                machines can share one directory and one comparison.
#   DRAFT        a draft model for speculative decoding. A GGUF model is run
#                with it (agency run --draft). For an MLX model, start the
#                server with --draft and set this to the same name, so the
#                results say what the server was doing.
#   PREFILL_STEP the --prefill-step the MLX server was started with, if
#                any, so the results say so. Recorded only.
#
# Every model also gets the same thinking policy: off on the cases that do
# not need it, on with one budget on the reasoning cases. See --thinking in
# run-model.agency to change that.
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
MAX_TOKENS="${MAX_TOKENS:-8192}"
LOCAL_TIMEOUT="${LOCAL_TIMEOUT:-300}"
LOCAL_TRIALS="${LOCAL_TRIALS:-1}"
HOSTED_TRIALS="${HOSTED_TRIALS:-3}"
MACHINE_LABEL="${MACHINE_LABEL:-}"
DRAFT="${DRAFT:-}"
PREFILL_STEP="${PREFILL_STEP:-0}"

if [ $# -gt 0 ]; then
  models=("$@")
else
  models=("${DEFAULT_MODELS[@]}")
fi

mkdir -p "$RESULTS_DIR"

files=()
failed=()
for entry in "${models[@]}"; do
  # What the results file records about this run, beyond what run-model
  # measures itself: the machine, the backend, and the speed settings that
  # apply to this backend. A draft applies to a local model; the prefill
  # step to the MLX server alone.
  record_flag=(--machine-label "$MACHINE_LABEL")
  if [[ "$entry" == local:* ]]; then
    name="${entry#local:}"
    model_flag=(--local "$name")
    # `agency local resolve` prints the backend first: "mlx" or "llama-cpp".
    backend="$($AGENCY local resolve "$name" 2>/dev/null | awk 'NR==1 { print $1 }')"
    backend="${backend:-llama-cpp}"
    record_flag+=(--backend "$backend" --draft-model "$DRAFT")
    if [ "$backend" = "mlx" ]; then
      record_flag+=(--prefill-step "$PREFILL_STEP")
    fi
    # A GGUF model takes its draft from the run. An MLX model's draft is the
    # server's business, and is only recorded here.
    if [ -n "$DRAFT" ] && [ "$backend" != "mlx" ]; then
      model_flag+=(--draft "$DRAFT")
    fi
    # The runtime's timeout is ten minutes. A reply that goes in circles
    # would use it up, and on a large model that is ten minutes per trial.
    cap_flag=(--max-tokens "$MAX_TOKENS" --timeout "$LOCAL_TIMEOUT" --trials "$LOCAL_TRIALS")
  else
    name="$entry"
    model_flag=(--model "$name")
    record_flag+=(--backend hosted)
    cap_flag=(--max-tokens "$MAX_TOKENS" --trials "$HOSTED_TRIALS")
    # The catalog routes OpenAI models to the "openai" provider, which is
    # the older chat completions API. Some cases fail there, so a bare
    # OpenAI name goes to "openai-responses" instead. A name that already
    # says its provider (openai/gpt-5.4-mini) is left alone.
    case "$name" in
      */*) ;;
      gpt-*|o[0-9]*) model_flag=(--model "openai-responses/$name") ;;
    esac
  fi
  # A flag BENCH_ARGS names wins: run-model refuses a flag given twice, so
  # the script's own copy is dropped.
  kept=()
  i=0
  while [ $i -lt ${#cap_flag[@]} ]; do
    flag="${cap_flag[$i]}"
    value="${cap_flag[$((i + 1))]}"
    case " $BENCH_ARGS " in
      *" $flag "*|*" $flag="*) ;;
      *) kept+=("$flag" "$value") ;;
    esac
    i=$((i + 2))
  done
  cap_flag=("${kept[@]}")
  # "mlx:mlx-community/Qwen3.8-27B-4bit" becomes "mlx_mlx-community_Qwen3.8-27B-4bit".
  safe="$(printf '%s' "$name" | tr '/:' '__')"
  if [ -n "$MACHINE_LABEL" ]; then
    safe="$safe--$(printf '%s' "$MACHINE_LABEL" | tr '/:' '__')"
  fi
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
  $AGENCY run "${model_flag[@]}" run-model.agency --label "$name" --out "$out" "${record_flag[@]}" ${cap_flag[@]+"${cap_flag[@]}"} $BENCH_ARGS 2>&1 | tee "$log"

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
