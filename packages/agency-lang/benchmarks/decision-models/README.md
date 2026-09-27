# Decision model benchmarks

Compare Jev, Laya, and a text model using token logprobs on the same labeled inputs. This directory includes the runner, SMS dataset, completed results, and Laya fine-tuning scripts. The runner calls smoltalk directly, so its timings exclude Agency compilation and checkpoint overhead.

## Recorded SMS results

Each model answered the same 500 messages three times, for 1,500 measured requests per model. Runs used one request at a time, one question per request, and one excluded warmup. All measured requests succeeded.

| Model | Accuracy | Macro-F1 | Spam precision | Spam recall | Median latency | p95 latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Jev via OpenRouter | 96.47% | 0.922 | 84.0% | 88.9% | 184 ms | 294 ms |
| Laya base | 86.20% | 0.777 | 47.7% | 96.8% | 40 ms | 63 ms |
| Laya fine-tuned | 94.20% | 0.886 | 69.8% | 95.2% | 40 ms | 59 ms |
| GPT-4o-mini logprobs | 91.20% | 0.833 | 60.1% | 89.4% | 482 ms | 925 ms |

Fine-tuning improved Laya by 8.0 percentage points. Per 500 messages, its false spam flags fell from 67 to 26, while missed spam rose from two to three. Jev had the highest accuracy in this comparison. Both Laya runs used a local Apple M3 GPU through MPS; the hosted models' timings include network and service overhead.

The test sample contains 437 ham and 63 spam messages. Always predicting ham would achieve 87.4% accuracy. This old public dataset may have appeared in model training, and it covers only binary SMS classification. Baseline test results were inspected before fine-tuning, although the test messages were excluded from training and validation. These results should be followed with fresh examples from the intended application.

See [the detailed comparison](results/sms/comparison.md) for probability errors and paired confidence intervals. Repetitions measure timing and response variation; there are 500 independent test cases, not 1,500.

## Contents

- `run.ts` and `src/`: TypeScript runner, adapters, metrics, and tests.
- `smoke.jsonl`: four authored cases for checking the runner.
- `data/sms/`: original UCI files, converted cases, exact-text deduplication, attribution, and checksums.
- `results/sms/`: four completed runs and the comparison report.
- `results/sms/finetune/`: exact splits, training history, checkpoint selection, environment versions, and verification reports.
- `finetune/`: training, checkpoint export, local serving, and verification scripts.

The JSON archives retain the original run metadata, including historical local paths. Model weights and Python environments are excluded from Git. Write new runs and checkpoints under the ignored `outputs/` directory.

## Build and check the data

Run these commands from `packages/agency-lang`:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc
pnpm exec tsc-alias
export BENCH=benchmarks/decision-models
mkdir -p "$BENCH/outputs"
pnpm benchmark:decisions --help
pnpm benchmark:decisions --data "$BENCH/smoke.jsonl" --backend laya --dry-run
pnpm benchmark:decisions --data "$BENCH/data/sms/sms-unique.jsonl" \
  --backend laya --limit 500 --seed 42 --repeats 3 --dry-run
```

Dry runs validate input and sampling without contacting a model. The committed dataset has 5,171 distinct message texts. Its SHA-256 and selected case IDs are recorded in every run.

## Run the comparison

Run one backend at a time. Each output filename must be new. Hosted calls require credentials and incur provider charges.

For Jev through OpenRouter, put your OpenRouter key in `TYPESAFE_API_KEY`, then run:

```bash
pnpm benchmark:decisions --data "$BENCH/data/sms/sms-unique.jsonl" \
  --backend jev --model jev-1.13 --base-url https://openrouter.ai/api \
  --limit 500 --seed 42 --repeats 3 --out "$BENCH/outputs/jev.jsonl"
```

Start the base Laya server using the [local setup instructions](finetune/README.md#install-and-start-the-base-model), then run:

```bash
pnpm benchmark:decisions --data "$BENCH/data/sms/sms-unique.jsonl" \
  --backend laya --model english --base-url http://127.0.0.1:8000 \
  --limit 500 --seed 42 --repeats 3 --out "$BENCH/outputs/laya-base.jsonl"
```

Set `OPENAI_API_KEY` for GPT-4o-mini, then run:

```bash
pnpm benchmark:decisions --data "$BENCH/data/sms/sms-unique.jsonl" \
  --backend logprobs --model gpt-4o-mini \
  --limit 500 --seed 42 --repeats 3 --out "$BENCH/outputs/logprobs.jsonl"
```

The recorded Jev run resolved to `typesafe/jev-1.13-20260917`. The text client retained the requested `gpt-4o-mini` name, without the server's resolved version. The Laya base revision is pinned in the setup instructions. Hosted aliases can change, so a fresh run may use different weights.

Follow the [fine-tuning instructions](finetune/README.md) to train Laya and benchmark the exported checkpoint. The archived result uses the best completed checkpoint from epoch three after a user-requested stop, with temperature 1 and no post-training calibration.

## Inspect results offline

```bash
for run in jev-openrouter-sms laya-english-sms laya-finetuned-sms logprobs-sms; do
  pnpm benchmark:decisions --summary "$BENCH/results/sms/$run.jsonl" \
    > "$BENCH/outputs/$run-summary.json"
done
```

These commands recompute accuracy, confusion counts, probability errors, latency, and throughput from the saved responses. See [RUNNER.md](RUNNER.md) for the JSONL schema, custom datasets, logprob handling, batching, and metric definitions.

## Tests

```bash
pnpm exec vitest run benchmarks/decision-models/src \
  > /tmp/decision-benchmark-tests.log 2>&1
.venv-laya/bin/python -m unittest discover -s "$BENCH/finetune" -p 'test_*.py' \
  > /tmp/laya-finetune-tests.log 2>&1
```

Tests cover dataset validation, metrics, request scheduling, HTTP adapters, archive integrity, split isolation, and cached-head parity. HTTP tests use a local fixture server. Automated tests make no paid calls and perform no model training.

## Dataset credit

Almeida, T. & Hidalgo, J. (2011), [SMS Spam Collection](https://doi.org/10.24432/C5CC84), UCI Machine Learning Repository. UCI lists the dataset under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The original messages are preserved; our conversions add benchmark questions and labels, remove duplicate texts, and partition the data. See [data provenance](data/sms/README.md).
