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

An MLX model is not one file. It is a directory of `.safetensors` weights next to a `config.json`, the layout Hugging Face repos use. Agency does not run it in its own process. A Python program called `mlx_lm.server` loads the model, and Agency sends it requests.

Set up Python once:

```bash
python3.12 -m venv ~/.agency-agent/mlx-env
~/.agency-agent/mlx-env/bin/pip install mlx-lm
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

1. You start the server yourself, and you stop it yourself. Nothing starts on demand.
2. The agent's memory feature stays off, because `mlx_lm.server` has no endpoint for embeddings.
3. MLX runs on Apple Silicon only. On any other machine, use the GGUF models above.

## What to expect

- The first call in a process loads the model into memory, which takes a few seconds for small models and noticeably longer for large ones. After that, the loaded model is reused for every call in the run.
- Speed depends on your hardware and the model size. On Apple Silicon, the model runs on the GPU via Metal automatically.
- One generation runs at a time per model. Concurrent LLM calls in your program queue up rather than running in parallel.

## See also

- [`agency local` command reference](/cli/local) covers every subcommand and config option.
- [LLM calls](/guide/llm) covers the `llm` function itself.
- [Custom providers](/guide/custom-providers) covers plugging in providers beyond the built-ins.
