# Model benchmark

Eleven cases that ask a model to do the things Agency programs do: answer fast, write at speed, fill a type, chain tools, reason past a trap, follow a format, find a line in a long log, label reviews, and say what a document does not say. Every model gets the same output cap and the same thinking policy, so the numbers can be compared. Each run records the machine it was made on and the settings it ran with, so runs from several machines can share one comparison.

Run `agency run run-model.agency --list` to see the cases. The header of `run-all.sh` lists every environment variable it reads.

## Before the first run on a machine

1. Build Agency: `make` in `packages/agency-lang`.
2. Install the local provider: `npm i -g smoltalk-llama-cpp`. It has to be 0.7.0 or later, or thinking cannot be turned off on GGUF models and the numbers will not match the other machines.
3. For MLX models, create the Python environment once, as the local models guide describes, and download the models below with `agency local download <name>`.
4. Set the API keys for the hosted models you run: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`.

Results go to `results/`. Keep `RESULTS_DIR` inside this directory, since Agency refuses to write elsewhere.

## What to run on each machine

Give every machine a label. It goes into each results file and its name, so the files from all machines can sit in one `results/` directory.

Each machine runs the largest dense model that fits it, the largest mixture-of-experts model that fits it, and the 2B as a floor that every machine shares. An MLX model needs its server running in another terminal, one model at a time. A GGUF model runs on its own.

### M3 MacBook Air, 24 GB

```bash
export MACHINE_LABEL=m3-air

# GGUF models run on their own.
./run-all.sh local:qwen3.5-2b local:qwen3.5-9b

# MLX models: start the server, run, Ctrl-C the server, next model.
agency local serve qwen3.5-9b-mlx      # in another terminal
./run-all.sh local:qwen3.5-9b-mlx
agency local serve gpt-oss-20b-mlx     # in another terminal
./run-all.sh local:gpt-oss-20b-mlx
```

gpt-oss-20b is 12 GB, which leaves the Air little room; if its server dies of memory on the needle case, drop it. The Air also slows down under sustained load, so run it on power with the lid open.

### M4 Max MacBook Pro, 36 GB

```bash
export MACHINE_LABEL=m4-max

./run-all.sh local:qwen3.5-2b local:qwen3.5-27b

agency local serve qwen3.5-27b-mlx
./run-all.sh local:qwen3.5-27b-mlx
agency local serve gemma-4-26b-a4b-mlx
./run-all.sh local:gemma-4-26b-a4b-mlx
```

### M1 Mac Studio, 64 GB

```bash
export MACHINE_LABEL=m1-studio

./run-all.sh local:qwen3.5-2b local:gemma-4-31b

agency local serve gemma-4-31b-mlx
./run-all.sh local:gemma-4-31b-mlx
agency local serve qwen3.5-35b-a3b-mlx
./run-all.sh local:qwen3.5-35b-a3b-mlx
```

### M5 Ultra Mac Studio, 256 GB

```bash
export MACHINE_LABEL=m5-ultra

./run-all.sh local:qwen3.5-2b local:gemma-4-31b

agency local serve gemma-4-31b-mlx
./run-all.sh local:gemma-4-31b-mlx
agency local serve qwen3-235b-a22b-2507-mlx
./run-all.sh local:qwen3-235b-a22b-2507-mlx
```

### Hosted models, from any one machine

One model per provider is enough for the reference line. Hosted runs get three trials, since sampling makes them differ and a run is cheap.

```bash
export MACHINE_LABEL=hosted
./run-all.sh claude-sonnet-5 gpt-6-astra gemini-3.5-flash-lite
```

## Measuring a speed setting

Do not run the whole suite for a setting. Thinking, a draft model, and the prefill step touch three cases, so run those before and after, and compare the `out tok/s` column. The settings table in the comparison says which run had what.

```bash
# Thinking off everywhere, against the default policy.
BENCH_ARGS="--cases throughput,needle,reasoning --thinking off" ./run-all.sh local:qwen3.5-27b

# A draft model for a GGUF model. The draft must be the same family.
DRAFT=qwen3.5-0.8b BENCH_ARGS="--cases throughput,needle,reasoning" ./run-all.sh local:qwen3.5-27b

# A draft model for an MLX model: the server takes it, and DRAFT records it.
agency local serve qwen3.5-27b-mlx --draft qwen3.5-0.8b-mlx
DRAFT=qwen3.5-0.8b-mlx BENCH_ARGS="--cases throughput,needle,reasoning" ./run-all.sh local:qwen3.5-27b-mlx

# A bigger prompt chunk on the MLX server. PREFILL_STEP only records it.
agency local serve qwen3.5-27b-mlx --prefill-step 8192
PREFILL_STEP=8192 BENCH_ARGS="--cases throughput,needle,reasoning" ./run-all.sh local:qwen3.5-27b-mlx
```

The lipogram case is left out of `all` on purpose: it makes small models loop, which measures the runtime's limits rather than the model. Run it with `BENCH_ARGS="--cases stress"` when that is what you want to measure.

## Comparing

Copy every machine's `results/*.json` into one directory and compare them all. A run that arrives twice, once on its own and once inside a combined file, is counted once.

```bash
agency run compare.agency results/*.json --out results/combined.json
```

When the files span more than one machine label, each column is headed `model @ machine`. Older result files, from before the machine and settings were recorded, still compare and show `-` where a value is missing.

## Reading the numbers

- `out tok/s` is the tokens the model wrote per second, thinking included. It is the speed of the machine on that model, and it does not depend on how long the prompts were.
- `story tok/s` counts the prompt too and only covers the throughput case. Prefer `out tok/s`.
- Latency includes the network round trip for a hosted model and not for a local one. Time to first token is not measured separately, so a comparison of latencies alone flatters a local model on short replies.
- OpenAI reasoning models ignore the thinking policy's off switch and think at their default effort, and Gemini keeps its own default when told off, because the Google client only sends a thinking setting when thinking is on. The settings table shows the policy that was asked for, not what each provider did with it.
- A local model's timed-out call is not retried, so a reply that goes in circles costs one timeout, not three.
