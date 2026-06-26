# Custom & local model providers

Agency selects models through smoltalk, which ships providers for OpenAI,
Anthropic, Google, and Ollama. To use a **custom or local** provider — for
example a local model via [`smoltalk-llama-cpp`](https://github.com/egonSchiele/smoltalk/tree/main/packages/smoltalk-llama-cpp) —
you register it with a small **provider module** that Agency loads at startup.

Agency never depends on the provider package itself: you install it, and you
write the few lines that register it.

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
