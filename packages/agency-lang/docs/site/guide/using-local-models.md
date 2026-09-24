---
name: Using Local Models
description: Run agents on models that live on your machine. Install the local provider, browse and download models, and use them with the agent, with agency run, and from the llm function.
---

# Using Local Models

Agency can run LLM calls on models stored on your own machine. Nothing leaves your computer, you need no API key, and the calls cost nothing. Local models are slower than hosted ones and less capable at the same size, so they shine for development, testing, offline work, and private data.

Local inference uses [llama.cpp](https://github.com/ggml-org/llama.cpp) under the hood. Models are single `.gguf` files, mostly downloaded from Hugging Face.

## Setup

Install the local provider once:

```bash
npm i -g smoltalk-llama-cpp
```

Agency finds the package automatically, whether you installed it globally or in your project. You can browse the catalog without it; any command that needs it will tell you to run this install.

## Browse the catalog

```bash
agency local list
```

The first line shows the directory models are downloaded to. Below it, you get the full catalog of curated models, with a checkmark next to the ones you have already downloaded:

```
Models directory: /Users/you/.agency-agent/models

   NAME          PARAMS  SIZE      CONTEXT  LICENSE
✓  smollm2-135m  135M    0.11 GB   8K       apache-2.0
   qwen3.5-2b    2B      1.28 GB   128K     apache-2.0
   gpt-oss-20b   20B     12.00 GB  128K     apache-2.0
   ...
```

For longer descriptions of each model, run `agency local alias list`.

**Picking a model:** the SIZE column is roughly what the model takes on disk and in memory, so it is the main thing to match against your hardware. Start small. `smollm2-135m` downloads in seconds and is good for checking that everything works. `qwen3.5-2b` is a reasonable first model for real tasks on a laptop.

## Download a model

```bash
agency local download
```

With no argument, this opens a picker so you can choose from the catalog. You can also name a model directly:

```bash
agency local download qwen3.5-2b
```

The value can be a curated name, one of your aliases, a Hugging Face URI, or a path to a `.gguf` file you already have:

```bash
agency local download hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M
```

Downloads of curated models are verified against pinned SHA-256 hashes. A file that fails verification is set aside and never loaded.

You do not have to download ahead of time. Everything that runs a local model downloads it first if it is missing. Pre-downloading just moves the wait to a moment you choose.

## See where models live

The first line of `agency local list` names the models directory. By default it is `~/.agency-agent/models`. To change it, set the `AGENCY_MODELS_DIR` environment variable, or set `client.modelsDir` in `agency.json`:

```jsonc
{
  "client": {
    "modelsDir": "/data/agency-models"
  }
}
```

To free up disk space, delete a model's files with `-f`. Without `-f` the
command only removes the alias and tells you where the files are.

```bash
agency local remove qwen3.5-2b -f
```

## Refresh the catalog

The catalog of curated models updates over time. Pull the latest list without upgrading agency:

```bash
agency local refresh
```

New and updated entries land in your `agency.json` as aliases. Any alias you added yourself is never overwritten. The [local command reference](/cli/local) covers the details, including pointing `refresh` at your own catalog.

## Run the agent on a local model

```bash
agency agent --local qwen3.5-2b
```

This downloads the model if needed and points every LLM call at it, including the deep subagents. A fully local session needs no hosted API key at all. Run `agency agent --local` with no value to pick from the catalog interactively.

## Run a program on a local model

The `--local` flag on `agency run` pins the whole run to a local model:

```bash
agency run --local qwen3.5-2b hello.agency
```

The value accepts the same forms as `agency local download`: a curated name, an alias, an `hf:` URI, or a `.gguf` path. The download and verification happen before your program starts, so you see the progress in your terminal. `--local` and `--model` are mutually exclusive.

This composes well with [run budgets](/cli/run). A run that must not spend money can say so explicitly:

```bash
agency run --max-cost 0 --local qwen3.5-2b hello.agency
```

## Use local models in code

For finer control, resolve a model in code and pass it to `llm` yourself. The `registerLocalModel` function downloads the model if needed and returns its local path:

```ts
import { registerLocalModel } from "std::agency/local"

node main() {
  const model = registerLocalModel("qwen3.5-2b")
  const answer = llm("What is the capital of France?", {
    model: model,
    provider: "llama-cpp",
  })
  print(answer)
}
```

Structured output and tool calls work the same way they do on hosted models:

```ts
type Capital = {
  city: string
  population: number
}

node main() {
  const model = registerLocalModel("qwen3.5-2b")
  const answer: Capital = llm("What is the capital of France?", {
    model: model,
    provider: "llama-cpp",
  })
  print(answer.city)
}
```

This is useful when one program mixes models, for example routing cheap classification to a local model and hard reasoning to a hosted one. `std::agency/local` also exports the rest of the CLI's capabilities as functions: `downloadModel`, `listModelNames`, `listDownloadedModels`, `aliasModel`, and more. See the [std::agency/local reference](/stdlib/agency/local).

To make local the default for a whole project instead, set it in `agency.json`:

```jsonc
{
  "client": {
    "defaultProvider": "llama-cpp",
    "defaultModel": "/Users/you/.agency-agent/models/my-model.gguf"
  }
}
```

## Name your own models with aliases

An alias gives a short name to any model URI, so your team can share one `agency.json` and write `llm(..., { model: registerLocalModel("my7b"), ... })` everywhere:

```bash
agency local alias add my7b hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M
agency local alias list
agency local alias remove my7b
```

Aliases work everywhere a model value is accepted: `agency local download`, `agency run --local`, `agency agent --local`, and `registerLocalModel`.

## Run MLX models on a Mac

MLX is Apple's array framework for Apple Silicon. Agency can run models through it as well as through llama.cpp. MLX models are often faster than GGUF models on a Mac, and the community publishes them at sizes llama.cpp builds rarely reach.

An MLX model is not one file. It is a directory of `.safetensors` weights next to a `config.json`, the layout Hugging Face repos use. Agency does not run it in its own process. A Python program called `mlx_lm.server` loads the model, and Agency sends it requests. Agency ships a small script around it that adds structured output, using the `llguidance` library, so a typed `llm()` call gets a reply that fits its type.

Set up Python once:

```bash
python3.12 -m venv ~/.agency-agent/mlx-env
~/.agency-agent/mlx-env/bin/pip install mlx-lm==0.31.3 llguidance==1.8.0
```

Agency looks for that environment by default. Agency never installs Python for you. To use a different Python, pass `--python`, or set `client.mlx.python` in `agency.json`.

### Download a model

```bash
agency local download mlx:mlx-community/Qwen3.8-27B-4bit
```

An `mlx:` URI names a Hugging Face repo. The download fetches the repo in parallel and verifies each file against the hash Hugging Face publishes. Interrupt it and run the same command again, and it picks up where it stopped.

Browse what is available with `agency local list`. MLX entries show `mlx` in the BACKEND column, and their names end in `-mlx` when a GGUF entry of the same model exists.

### Start the server

```bash
agency local serve
```

With no model named, this shows you the MLX models you have downloaded, and you pick the ones to serve. Name them yourself to skip the picker:

```bash
agency local serve mlx:mlx-community/Qwen3.8-27B-4bit
```

The command runs in the foreground and prints the address it is listening on. Leave it running in its own terminal. Ctrl-C stops it and every model it loaded.

You can serve several models at once. Agency starts one `mlx_lm.server` for each of them and puts a single port in front. Each model stays in memory for as long as the command runs, so watch the total against the memory your Mac has. Agency warns you when the models add up to more than that, and starts them anyway.

A server uses memory beyond its weights while it works, and it cuts short a reply that goes in circles. Both are covered under [What is different about a local model](#what-is-different-about-a-local-model) below, along with the flags that tune them.

### Run against the server

```bash
agency run --local mlx:mlx-community/Qwen3.8-27B-4bit hello.agency
agency agent --local mlx:mlx-community/Qwen3.8-27B-4bit
```

These work the same way they do for a GGUF model, with one difference. Agency does not download or load anything here. The server has to be running already, and it has to be serving the model you name.

A run sends the model name to the server, so the two must agree. `agency local resolve <name>` prints the name Agency will send.

### Use a model you already have

```bash
agency local serve /Volumes/models/hf/hub/models--mlx-community--Qwen3.8-27B-4bit
```

Any directory holding `config.json` and `.safetensors` files works, so a model another tool downloaded needs no copying. A Hugging Face cache folder works too. Agency reads its `refs/main` to find the revision you last pulled.

```bash
agency local --model-dir /Volumes/models/hf/hub list
agency local --model-dir /Volumes/models/hf/hub serve
```

`--model-dir` points the whole `local` command at another directory for one run. The picker then offers everything in that directory. Agency reads a Hugging Face cache but never writes to one, so `agency local remove -f` refuses to delete a model in one.

### Watch what the server is doing

The server prints one line per request:

```
POST /v1/chat/completions  mlx-community/Qwen3.8-27B-4bit  200  2.6s  16→129 tok
```

That line gives you the endpoint, the model, the status, the time the request took, and the tokens in and out. Add `--verbose` to see the whole request and the whole reply as well:

```bash
agency local serve mlx:mlx-community/Qwen3.8-27B-4bit --verbose
```

### Shorter names

```bash
agency local alias add coder mlx:mlx-community/Qwen3-Coder-Next-4bit
agency local serve coder
agency run --local coder hello.agency
```

An alias works everywhere a model value is accepted, the same as it does for a GGUF model.

If you already have the model, you can also drop the prefix and use the repo id on its own:

```bash
agency local serve mlx-community/Qwen3-Coder-Next-4bit
```

The `mlx:` prefix is the spelling that always works. You need it for a model you have not downloaded yet, because that is what tells Agency where to fetch it from.

### Differences from GGUF models

The table at the end of [What is different about a local model](#llamacpp-and-the-mlx-server-side-by-side) sets the two backends side by side. One difference is not in it: the agent's memory feature stays off on the MLX server, because `mlx_lm.server` has no endpoint for embeddings.

## What is different about a local model

A hosted provider makes a dozen small choices for you, and you never see them. A local model makes you see every one. This section lists the choices that catch people, what each looks like when it goes wrong, and what to do about it. Most apply to both backends. Where one applies to the MLX server alone, or to llama.cpp alone, the text says so.

### The same prompt gives the same reply

Both local backends pick the single likeliest token at every step when nothing tells them otherwise. This is called greedy decoding. A greedy model writes the same reply for the same prompt every time, to the token, and takes the same time doing it. Every hosted provider samples instead, at a temperature of 1.0, so its replies vary from call to call.

Agency gives a local model that same temperature of 1.0 when a call names none, so the two behave alike. Ask for the repeatable behaviour when you want it:

```ts
import { setLlmOptions } from "std::llm"

setLlmOptions({ temperature: 0 })
```

Two things follow from greedy decoding. Running a greedy model three times measures nothing the first run did not, so a benchmark at temperature 0 needs one trial. And a greedy model that starts going in circles cannot get out of them, because whatever led it to write "But wait" once leads it to write the same thing again.

### Thinking spends your output budget

A thinking model writes a block of reasoning before its answer. Your program never sees that block, but it counts against `maxTokens` along with the answer. A small model can spend thousands of tokens thinking about a one-line question. When the budget runs out inside the thinking block, the call returns an empty reply with a stop reason of `length`, and a typed call fails with "reply did not fit the type".

Turn thinking off when the task does not need it:

```ts
import { setLlmOptions } from "std::llm"

setLlmOptions({ thinking: { enabled: false } })
const label: string = llm("Is this review positive or negative? ...")
```

This asks the model's chat template to open no thinking block. On a classification or extraction task it saves most of the time a thinking model takes. Where thinking helps, give it a budget instead:

```ts
const answer: NumberAnswer = llm(problem, { thinking: { enabled: true, budgetTokens: 2048 } })
```

After the budget, the thinking block is closed for the model and it has to answer. `reasoningEffort` works too, and means the same amount of thinking on a local model as it does on Gemini:

| effort | tokens of thinking |
| ------ | ------------------ |
| low    | 2048               |
| medium | 8192               |
| high   | 16384              |

Both backends honour all of this. On the MLX server the switch goes to the chat template and the budget to the server's watcher. On llama.cpp the switch goes to the chat wrapper, for the models whose wrapper has one, and the budget to llama.cpp itself. Qwen, Gemma 4, and Seed models can be switched off there. A gpt-oss model can only be asked for its lowest effort, and a DeepSeek model always opens its block, so off means a budget of zero and the block closes at once.

### Replies that go in circles

A model that is unsure can write "But wait, is that right? Let me reconsider." for thousands of tokens, or repeat one sentence until its budget runs out. With a hosted model this costs you money. With a local one it costs you the machine. A large model can take ten minutes to write a reply nobody wants, and every other call waits behind it.

The MLX server watches every reply for three signs of this:

1. Thinking past its budget. The budget is half of `maxTokens` unless the call sets `budgetTokens`.
2. More than twelve second thoughts. "But wait", "Wait", "Hmm", "Hold on", "Let me reconsider", and phrases like them.
3. The same sentence of six or more words, written three times.

When the server sees one, it cuts the reply short in the way that leaves the most usable result. A thinking block is closed, so the answer can follow. A reply that must fit a type has the text field it is writing closed, so the rest of the type can still be filled in. A plain reply ends where it is. The server prints a line saying which limit tripped and what it did.

You can change the limits when you start the server. `0` turns one off:

```bash
agency local serve mlx:mlx-community/Qwen3.5-2B-4bit --hedge-limit 20 --repeat-limit 0
```

A strong model doing careful work can say "Wait" a dozen times honestly. If you see it cut off mid-thought, raise `--hedge-limit`.

llama.cpp has no watcher. There, a reply that goes in circles runs to `maxTokens` or to the call's timeout, whichever comes first.

### Every call has a cap and a clock

Two limits bound every call, and a local model hits both more often than a hosted one. The cap is `maxTokens`. llama.cpp caps a call at 16,384 tokens when you set none. The MLX server caps it at its `--max-tokens`, also 16,384 by default, and a call that asks for more gets that much. The clock is the runtime's per-call timeout of ten minutes. A call that hits it fails with "Request was aborted".

Set both lower for a local model, because a reply that goes in circles costs the whole cap and the whole clock:

```ts
setLlmOptions({ maxTokens: 8192, timeout: 300000 })
```

`timeout` is in milliseconds. Every honest reply seen in Agency's own benchmark fit in 8,192 tokens. The longest was a 4B thinking model at about 7,300.

### A reply you gave up on keeps running, unless something stops it

When a call times out, or you press Ctrl-C, your program moves on. The model does not know that. llama.cpp runs inside your process, so Agency stops it directly. The MLX server is another process behind a socket, and `mlx_lm.server` on its own only looks at that socket once the reply is finished. Agency's chat server looks every half second instead, and drops the reply within that time. The server's log shows it:

```
The client went away; stopping its reply.
```

An abandoned reply that nothing stops runs to `maxTokens`, and every other request shares the GPU with it and runs two to three times slower. If a local model gets slower as a run goes on, check for this first.

### Memory is the weights, plus everything the server remembers

A model's size on disk is the floor of what it needs, not the total. Each reply being generated holds attention state that grows with the prompt and the reply. On a 235B model that is about 190KB per token, so a 22,000-token prompt adds 4GB. The MLX server also keeps that state for the last ten prompts it saw, so a follow-up on the same conversation skips re-reading it. And the GPU keeps memory it has freed around for reuse.

None of this shrinks on its own. A long run on a large model grows until the GPU runs out of memory. The server then stops answering, and every later call waits out its timeout. The system log records the moment:

```
Execution of the command buffer was aborted due to an error during execution. Insufficient Memory
```

Agency limits the server to a sixteenth of the machine's memory for attention state, and the server drops its oldest prompts to stay under. Watch the `Prompt Cache` lines the server prints to see how much it holds. Leave headroom when you pick a model. A 123GB model on a 256GB Mac leaves 17GB for everything else once the GPU has its share.

### Prompts cost time up front, replies cost time per token

A reply takes two kinds of time. Reading the prompt is one batch of work that grows with the prompt's length. A 22,000-token prompt took 28 seconds on a 235B model before the first token came out. Writing the reply then costs a fixed time per token. That time is set by how fast the machine can read the model's weights, not by how much arithmetic it does. That is why a 235B model with 22B active parameters and a dense 31B model both write at about 40 tokens per second on the same Mac.

Two things follow. A long prompt is expensive even when the reply is one word, so keep the long prompts to the calls that need them. And the biggest speed-up for a thinking model is not a faster machine, it is `thinking: { enabled: false }` on the calls that do not need it.

### Speculative decoding

Since writing a reply is bound by reading the weights, a smaller model can help a larger one. The small model, the draft, guesses the next few tokens cheaply. The large model then checks the whole guess in one pass, which costs it about the same as writing one token, and keeps every token it agrees with. The reply is exactly what the large model would have written alone, only sooner. On prose the gain is usually 1.5x to 2x. On a typed reply it is less, because the grammar makes the draft's guesses wrong more often.

```bash
agency local serve mlx:mlx-community/Qwen3-235B-A22B-Instruct-2507-4bit --draft mlx:mlx-community/Qwen3-0.6B-4bit
agency run --local qwen3.5-4b --draft qwen3.5-2b hello.agency
```

The first line drafts for an MLX model, the second for a GGUF one. The draft has to share the main model's tokenizer, which in practice means the smallest member of the same family, and both backends refuse a pair that does not match. `--draft-tokens` on the server sets how many tokens the draft guesses at a time, four by default. A draft turns off batching on the MLX server, so calls run one at a time there while it is in use.

Whether a draft pays off depends on the pair and the machine, so measure it: run the throughput case of the benchmark with and without the draft and compare the output speed. A draft that is too large gains little, because checking its guesses costs almost what it saves.

### Long prompts and the machine's memory

The MLX server reads a long prompt in chunks. A bigger chunk keeps the GPU busier, so the prompt is read sooner, but the attention scores of one chunk against the whole prompt have to fit in memory at once. Agency sizes the chunk from the machine's memory: 2048 tokens under 64GB, 4096 up to 128GB, and 8192 above. `--prefill-step` on `agency local serve` overrides that. Raise it if you have memory to spare and long prompts to read; lower it if the server runs out of memory on a long prompt.

### Several calls at once

llama.cpp runs one reply at a time inside your process, and other calls wait their turn. The MLX server batches replies, so calls made at the same time share the GPU and finish sooner together than one after another. Each call still takes about as long as it would alone, so this helps a program with independent calls, not a single slow one. Make the calls concurrent the way you would any Agency work, with [`fork` or `parallel`](/guide/concurrency).

Time to first token is not measured separately by Agency yet. A hosted model's latency includes the network round trip and the provider's queue, and a local model's does not, so a comparison of latencies alone flatters the local model on short replies.

### A type shapes the reply, but cannot make it right

A typed `llm()` call on a local model gets a reply that fits the type, because a grammar forbids every token that would break it. Two things are worth knowing. A call that passes tools is not constrained, since a tool call is not JSON. And the grammar shapes the reply without judging it. Asked for a date as a string, a model can write `March 14, 2026` where you wanted `2026-03-14`, and the grammar is satisfied. Say the format you want in the prompt or in the field's description.

### The context window is smaller than you think

The prompt, the thinking, and the answer all share one context window. llama.cpp gives a model 32,768 tokens of it in Agency. A prompt near that size leaves no room for a reply, and the call fails with a context error. The MLX server uses the model's own limit, which is usually larger.

### llama.cpp and the MLX server, side by side

|                        | llama.cpp                    | MLX server                             |
| ---------------------- | ---------------------------- | -------------------------------------- |
| Runs                   | inside your process          | as a process you start and stop        |
| Loads the model        | on the first call, every run | once, when you start the server        |
| Calls at the same time | one at a time, the rest wait | several, batched together              |
| Abandoned reply        | stopped at once              | stopped within half a second           |
| Thinking on, off, budget | yes, where the model's wrapper has a switch | yes                     |
| Watches for loops      | no                           | yes                                    |
| Speculative decoding   | `agency run --draft`         | `agency local serve --draft`           |
| Output cap             | 16,384 unless the call says  | the server's `--max-tokens`            |
| Context window         | 32,768 tokens                | the model's own                        |
| Where it runs          | any machine                  | Apple Silicon only                     |

## See also

- [`agency local` command reference](/cli/local) covers every subcommand and config option.
- [LLM calls](/guide/llm) covers the `llm` function itself.
- [Custom providers](/guide/custom-providers) covers plugging in providers beyond the built-ins.
