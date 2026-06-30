# Custom & local model providers

Agency selects models through smoltalk, which ships providers for OpenAI,
Anthropic, Google, and Ollama, plus four built-in **hosted open-model**
providers (OpenRouter, DeepInfra, LiteLLM, and a generic OpenAI-compatible
provider — see below). To use any *other* **custom or local** provider — for
example a local model via [`smoltalk-llama-cpp`](https://github.com/egonSchiele/smoltalk/tree/main/packages/smoltalk-llama-cpp) —
you register it with a small **provider module** that Agency loads at startup.

Agency never depends on the provider package itself: you install it, and you
write the few lines that register it.

## Hosted open-model providers (built in)

To run open models (GLM, Qwen, DeepSeek, gpt-oss, …) on a hosted service, use
one of smoltalk's four built-in providers — **no provider module needed**, just
a key:

| Service | `provider` value | Base URL | API key (config / env) |
|---|---|---|---|
| OpenRouter | `openrouter` | baked in (override `baseUrl.openRouter`) | `apiKey.openRouter` / `OPENROUTER_API_KEY` |
| DeepInfra | `deepinfra` | baked in (override `baseUrl.deepInfra`) | `apiKey.deepInfra` / `DEEPINFRA_API_KEY` |
| LiteLLM (self-hosted proxy) | `litellm` | **required**: `baseUrl.liteLlm` / `LITELLM_BASE_URL` | `apiKey.liteLlm` / `LITELLM_API_KEY` |
| Any OpenAI-compatible API (Fireworks, Together, Groq, …) | `openai-compat` | **required**: `baseUrl.openAiCompat` / `OPENAI_COMPAT_BASE_URL` | `apiKey.openAiCompat` / `OPENAI_COMPAT_API_KEY` |

Set the key via the env var, or in `agency.json` under `client.apiKey`. Because
these model names aren't in smoltalk's model registry, you must always **name
the provider explicitly** — either globally via `client.defaultProvider`, or
per call: `llm("...", { provider: "openrouter", model: "z-ai/glm-5.2" })`.

```jsonc
// agency.json — set OpenRouter as the default provider + model
{
  "client": {
    "apiKey": { "openRouter": "sk-or-..." },
    "defaultProvider": "openrouter",
    "defaultModel": "z-ai/glm-5.2"
  }
}
```

OpenRouter and DeepInfra return the real per-request cost in their responses, so
Agency's cost tracking works automatically with no price table. Services reached
via `openai-compat` (e.g. Fireworks, Together) report token usage but not cost.
LiteLLM cost is read from a response header and is available for non-streaming
calls only.

## Local models (the easy way)

Install the local-model package once, then use the `agency local` tools or the
agent's `--local-model` flag:

```bash
npm i -g smoltalk-llama-cpp

agency local download qwen3.5-2b          # curated name, hf: URI, or .gguf path
agency local list                         # downloaded models + sizes
agency local alias add my7b hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M
agency local alias list                   # curated names + your aliases
agency local remove qwen3.5-2b

agency agent --local-model qwen3.5-2b     # download (if needed) + run locally
```

`--local-model` runs the local model as both the fast and slow model, so the
deep subagents stay local too; it ignores `--model`/`--provider`/`--fastmodel`/
`--slowmodel`. Downloads cache under `~/.agency-agent/models` (override with
`AGENCY_MODELS_DIR`).

Programmatically, `std::agency/local` exposes the same operations
(`downloadModel`, `listDownloadedModels`, `aliasModel`, `registerLocalModel`,
…), and `std::llm`'s `registerProviderModule(path)` registers any custom
provider module at runtime.

The rest of this page covers the fully manual route for any custom provider.

---

## 1. Install the provider package

```bash
npm install -g smoltalk-llama-cpp   # brings in node-llama-cpp
```

## 2. Write a provider module

A provider module is an ES module that exports `register`. It receives
Agency's `registerProvider` — do **not** import `registerProvider` from
`smoltalk` yourself; using the injected one guarantees the provider is
registered into the smoltalk instance Agency actually uses.

```js
// llama-setup.mjs
import { LlamaCPP } from "smoltalk-llama-cpp";

export function register({ registerProvider }) {
  registerProvider("llama-cpp", LlamaCPP);
}
```

## 3. Tell Agency to load it

Either in `agency.json` (relative paths resolve against the directory you run
Agency from):

```json
{
  "client": {
    "providerModules": ["./llama-setup.mjs"]
  }
}
```

…or via an environment variable (comma-separated):

```bash
export AGENCY_PROVIDER_MODULES="/abs/path/to/llama-setup.mjs"
```

Both sources are merged. A module that fails to load, lacks a `register`
export, or throws during `register` is a fatal startup error — Agency will not
silently fall back.

::: tip Prefer absolute paths
Relative paths resolve against the **current working directory**. For the env
var — which is inherited by subprocesses that may run with a different cwd (see
below) — prefer **absolute** paths so they resolve everywhere.
:::

## 4. Use the provider

Select it like any other provider — by flag (agent), with `setModel` /
`setLlmOptions`, or per call. `smoltalk-llama-cpp` takes the `.gguf` path as
the model and the model directory via `metadata`:

```
import { setLlmOptions } from "std::llm"

node main() {
  setLlmOptions({ provider: "llama-cpp", model: "my-model.gguf" })
  return llm("Hello!", { metadata: { llamaCppModelDir: "./models" } })
}
```

For the Agency agent, the existing model flags work once the provider is
registered:

```bash
agency agent --provider llama-cpp --model my-model.gguf
```

## Subprocesses (`run` / `runFile`)

Agency code that spawns a subprocess via `std::agency`'s `run` / `runFile`
runs a *separately-compiled* program in a fresh process with its own provider
registry, so providers must be re-registered there. Both happen automatically:

- The `AGENCY_PROVIDER_MODULES` env var is **inherited** by the subprocess.
- The parent's **config-declared** `providerModules` are **forwarded** to the
  subprocess (resolved to absolute paths against the parent's cwd first), so a
  child loads the same providers the parent has — even though it was compiled
  separately and may run with a different `cwd`.

You don't need to duplicate provider config for subprocess code.

## How it works

Agency loads provider modules once per process, before any `llm()` call, in
the same bootstrap that initializes globals — so a registered provider is
available everywhere, including forks, `agency serve`, subprocesses, and
`agency pack` artifacts. The provider package is loaded at runtime from your
install; it is never bundled into a packed artifact.
