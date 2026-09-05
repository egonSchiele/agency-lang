# MLX tool-calling spike: spec

Written 2026-09-05. Branch `adit/mlx-spike`. The plan that carries this out is
`2026-09-05-mlx-tool-calling-spike-plan.md`, next to this file.

This spec describes an experiment, not a feature. The experiment answers one
question: can Agency call tools through an MLX model served by a Python
process, well enough and fast enough to build on? Everything after the spike
(a `smoltalk-mlx` plugin, catalog and download changes, a managed daemon)
depends on the answer, and none of it is specified here.

## Part 1: Background

### What Agency's local-model path is today

Agency makes every model call through smoltalk, a TypeScript library with one
client class per provider. Local inference is one of those providers, named
`llama-cpp`. It lives in its own npm package, `smoltalk-llama-cpp`, which
wraps node-llama-cpp. node-llama-cpp bundles the llama.cpp engine as a native
Node module, so the model runs inside the Agency process itself. There is no
server and no second process.

That package is optional. smoltalk declares it as an optional peer dependency
and loads it on demand. The loader is `lib/clients/llamaCppLoader.ts` in the
smoltalk package. It imports the bare specifier `smoltalk-llama-cpp`, checks
the module exports a `LlamaCPP` class and a `resolveModel` function, and
registers the class under the provider name `llama-cpp`. Agency's half is
`lib/runtime/localProvider.ts`, which finds the package in places smoltalk
cannot see, such as a global `npm i -g` install.

Everything above that seam assumes one model file format, GGUF:

- `_resolveModelName` in `lib/stdlib/localModels.ts` accepts a `.gguf` path,
  an `hf:` or `https:` URI, an alias, or a curated short name.
- Every entry in `CURATED_LOCAL_MODELS` points at an `hf:<org>/<repo>-GGUF`
  URI.
- Downloads go through node-llama-cpp's own resolver, which verifies a
  SHA-256 and records the resulting `.gguf` basename in a manifest.
- `agency run --local <model>` and `agency agent --local-model <model>` both
  pin the provider to `llama-cpp` in code.

None of that is wrong. It is a complete feature that ships to users, and it
stays. See `docs/dev/llm/local-models.md` for the full wiring.

### What MLX is, and why the downloaded models need it

MLX is Apple's array framework for Apple Silicon. The Python package `mlx-lm`
runs language models on top of it. Models for MLX are published as
safetensors files with an MLX-specific quantization layout, mostly under the
`mlx-community` organization on Hugging Face.

The five models on the Mac Studio's external SSD are all in that format. The
handoff `2026-09-05-handoff-local-models-mlx-vs-llamacpp.md` explains why
converting them to GGUF is a dead end. In one sentence each: you cannot
convert between two quantized formats without re-downloading the originals at
two to four times the size, stock llama.cpp cannot load DeepSeek V4 Flash at
all, and two copies of every model would not fit on the drive.

There is no MLX equivalent of node-llama-cpp. The Node bindings that exist
(`@frost-beta/mlx` and `@frost-beta/llm`) last shipped in 2024 and support
Llama 3 and Qwen 2.5 only. Running Qwen3-Coder-Next or DeepSeek V4 from Node
in-process would mean porting each model architecture to JavaScript ourselves.
That is the full-time job of the mlx-lm project, so we do not do it.

The conclusion is that MLX inference has to run in a Python process. That
process must load the model once and keep it in memory, because loading a
45GB to 184GB model takes minutes. Agency talks to it over HTTP.

### The two servers

Two Python servers can play that role. Both speak the OpenAI chat-completions
wire format, so from Agency's side they look identical.

**`mlx_lm.server`** ships with mlx-lm itself. Reading its `server.py`:

- It accepts the request's `tools` array and emits `tool_calls` in the reply.
  It has a tool parser and a state machine that separates tool text from
  ordinary text.
- It streams.
- It keeps an LRU prompt cache across requests, so a second turn that shares
  a prefix with the first does not re-process the whole conversation.
- The `model` field in a request may name a different model. The server
  loads it on demand.
- Its `--max-tokens` flag defaults to 512 and applies whenever a request does
  not set `max_tokens`. Agency does not set it. So the server must be started
  with a much larger value or every long reply gets cut off.
- It does not log tokens per second. Speed has to be measured from outside.

**`mlx-openai-server`** is a third-party project (`cubist38/mlx-openai-server`).
It lists function calling as a first-class feature with per-model parsers:
`qwen3`, `qwen3_5`, `qwen3_coder`, `qwen3_moe`, `qwen3_next`, `qwen3_vl`,
`glm4_moe`, `harmony`, `minimax_m2`. It also runs vision models through
mlx-vlm. Its README's example for a text model with tool calling is exactly
one of our models:

```bash
mlx-openai-server launch \
  --model-type lm \
  --model-path mlx-community/Qwen3-Coder-Next-4bit \
  --reasoning-parser qwen3_moe \
  --tool-call-parser qwen3_coder
```

It requires Python 3.11 or newer.

The spike starts with `mlx_lm.server`, because it is the official one and has
no extra install. `mlx-openai-server` is the fallback if the official server
fails any check.

### How Agency reaches an OpenAI-shaped server today

smoltalk has a provider named `openai-compat` for exactly this. Its client is
`lib/clients/openaiCompat.ts`, a small subclass of the OpenAI client that
reads its base URL and API key from config or from the env vars
`OPENAI_COMPAT_BASE_URL` and `OPENAI_COMPAT_API_KEY`. Both are required by the
client even when the server ignores the key. It reports token usage but no
cost, because the model is not in smoltalk's price table.

Agency's `run` command takes `--model provider/model`. Everything before the
first slash is the provider. So this one command line points a run at the
local server, with no code changes anywhere:

```bash
export OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_COMPAT_API_KEY=unused
pnpm run agency run --model openai-compat/mlx-community/Qwen3-Coder-Next-4bit spikes/mlx-tool-calling/add.agency
```

That is why the spike needs no Agency or smoltalk code at all. The whole
experiment is: start a server, set two env vars, run three programs.

### Which model to test with

The smallest model on the drive, `mlx-community/Qwen3.8-27B-4bit` at 16.1GB,
is a vision model converted with mlx-vlm. `mlx_lm.server` may refuse to load
it. So the spike uses the next one up, `mlx-community/Qwen3-Coder-Next-4bit`
at 44.9GB. It is a text model, it is trained for tool use, and it is the model
the mlx-openai-server README uses in its own tool-calling example. It should
load in about a minute from the SSD.

The larger models are not part of the spike. Loading 150GB to find a protocol
bug wastes twenty minutes per attempt. They come after tool calling is
proven.

## Part 2: What the spike checks

Six checks, in order. Each one only makes sense if the one before it passed.

### Check 0: the server loads the model

Start `mlx_lm.server` on Qwen3-Coder-Next. Record how long the load takes and
how much memory the process holds afterwards. A failure here is an
environment problem (SSD not mounted, wrong `HF_HOME`, missing package) or a
model the server cannot load.

### Check 1: raw protocol

Send one chat completion with `curl`, including a `tools` array with one
function, `add(a, b)`. No Agency involved. Pass means the reply contains a
`tool_calls` entry naming `add` with arguments 17 and 25. This isolates the
server and the model from everything above them. If this fails, the fault is
in the server or the model, and checks 2 through 4 will fail for the same
reason.

### Check 2: one tool through Agency

Run `spikes/mlx-tool-calling/add.agency`. It defines one function and makes
one `llm()` call with that function as a tool. Pass means the line
`add called with 17 and 25` is printed before the answer. That line proves the
whole path: smoltalk turned the Agency function into a tool definition, the
server turned the model's reply into a `tool_calls` entry, smoltalk called the
function, and the model saw the result. An answer of 42 without that line is
a fail: the model did the arithmetic itself.

### Check 3: two tools, one depending on the other

Run `spikes/mlx-tool-calling/two-tools.agency`. It defines `getWeather(city)`
and `convertToFahrenheit(celsius)` and asks for Paris in Fahrenheit. Pass
means both tools were called, in that order, and the answer is 64.4. This
adds three things check 2 does not cover: a string argument, choosing between
two tools, and a second tool call after the first result came back.

### Check 4: the agent

Run `agency agent --print` with a prompt that needs a couple of read-only
tools, with the provider and model set to the local server. The agent is the
real workload: a long system prompt, dozens of tools, several rounds. Pass
means the agent called at least one tool and gave a sensible answer. This is
the check most likely to expose a weak tool parser, because the tool list is
large and the model has to produce well-formed calls under a long context.

### Check 5: speed and caching

Measure generation speed on one longer reply, and confirm that the second
turn of a conversation hits the prompt cache. The server does not log tokens
per second, so speed is wall time divided by the completion token count from
the response's `usage` field. A cache hit shows in the server's log as a
short prompt-processing progress line on the second request instead of the
full prompt length.

There is no llama.cpp number to compare against, because the same model does
not exist as a GGUF that stock llama.cpp can load. Record the number. The
plugin spec will set a target from it.

### The fallback

If check 1, 2, 3, or 4 fails on `mlx_lm.server`, install `mlx-openai-server`
and repeat the failed checks against it, with the `qwen3_coder` tool parser.
Only after both servers have been tried does a failure count as a NO-GO.

## Part 3: Go/no-go

**GO** means checks 0 through 4 pass on at least one server, and check 5
produced a number. The follow-up spec then designs the `smoltalk-mlx` plugin
as a subclass of the `openai-compat` client, against whichever server passed.

**NO-GO** means tool calling failed on both servers. The follow-up is then a
different design: our own Python sidecar that uses mlx-lm's generate API
directly and does the tool-call parsing itself. That is more work, and this
spike is what decides whether it is needed.

Either way, `RESULTS.md` in the spike directory records what happened, and
the branch is pushed so the results travel.

## Part 4: What is out of scope

- No changes to smoltalk, `smoltalk-llama-cpp`, or any Agency source file.
- No new provider name. The spike uses `openai-compat` as it exists.
- No catalog or download changes. The models are already on disk.
- No daemon or lifecycle management. The server is started by hand in a
  terminal and left running.
- No test in the vitest suites. The spike is run by hand on one machine.
- No vision models, and no model larger than Qwen3-Coder-Next.

## Part 5: Files on the branch

All under `packages/agency-lang/spikes/mlx-tool-calling/`:

| File | Purpose |
|---|---|
| `start-server.sh` | Starts `mlx_lm.server` with the right `HF_HOME` and `--max-tokens`. |
| `curl-tools.sh` | Check 1. One raw chat completion with a tools array. |
| `add.agency` | Check 2. One function, one `llm()` call. |
| `two-tools.agency` | Check 3. Two functions, chained. |
| `RESULTS.md` | The table to fill in, and the GO/NO-GO decision. |

Both `.agency` files parse and compile on this branch. Nothing else in the
repository references the `spikes/` directory, and no CI job runs anything in
it.
