# AgencyConfig

## Overview

`AgencyConfig` (`lib/config.ts`) defines all compiler and runtime configuration options for Agency. It is typically loaded from an `agency.json` file in the project root, but can also be passed programmatically. The CLI accepts a `-c` / `--config` flag to specify a custom config file path.

For basic usage examples, see `docs/config.md`.

## Config resolution (single source of truth)

The effective config for a program is assembled from three sources, defined and
documented in one place — the "Config resolution" section at the bottom of
`lib/config.ts`. In increasing precedence:

1. **`agency.json`** — the file, walked up from cwd (`loadConfigSafe`). The base.
2. **CLI flags** — `--trace` / `--log-file` / `--strict`, mapped onto config by
   `applyCliFlags()`. This is the only definition of what each flag means.
3. **`AGENCY_CONFIG_OVERRIDES`** — a JSON `Partial<AgencyConfig>` in the
   environment (`readConfigOverrides`). Used to push config into a process whose
   config was baked at compile time and can't be re-derived from source (the
   precompiled built-in agents, `agency pack` bundles). It is the env-transport
   twin of the subprocess IPC `configOverrides` message, and both are applied by
   the single runtime merge `applyRuntimeConfigOverridesToContextArgs`.

Where applied: sources 1⊕2 at the CLI (baked into the generated program);
source 3 at runtime, in the `RuntimeContext` constructor. Inspect the resolved
result with `agency config show` (secrets masked; `--show-secrets` to reveal).

### Every command translates its flags in the same place

`applyCliFlags` is the only definition of what a flag means, and every command
that turns a flag into a setting calls it — `run`, `compile`, `typecheck`, and
the bundled agents. Do not hand-write `config.x = y` in a command action. The
one exception is the root `-v` / `-c`, handled inside `getConfig()` itself, so
it is still applied in exactly one place for every command.

`typecheck` was the last holdout and was migrated in the change that added this
section. Its `--strict` was hand-written rather than shared — but its narrower
meaning was correct, and is preserved. See the next section.

### The same flag name may mean different things on different commands

`--strict` is the live example. On `run`/`compile` it sets both `strict` and
`strictTypes`, because the compile path has a gate that only opens on `strict`.
On `typecheck` it sets `strictTypes` alone: that command runs the checker
unconditionally and computes its own exit code, so it never reaches the gate.

Setting `strict` on `typecheck` would therefore be **inert**, not harmful —
`typechecker.strict` has exactly one reader in the repo, the gate itself
(`lib/compiler/compile.ts`). The narrow field is still the right call for a
different reason: a setting that reads as meaningful and does nothing is a
trap, and it would quietly begin to matter the day `typecheck` grows a compile
path.

The two meanings are two fields on `CliFlags` (`strict` and `strictTypes`), not
a branch inside `applyCliFlags`. The command picks the meaning it wants by
choosing a field; the helper never needs to know which command called it.

### `--refuse-splices`

`refuseSplices` declines compile-time generator execution: a file containing a `$( ... )` fails with `AG8016` instead of the generator being run. Off by default, available on `compile`, `run`, `typecheck` and `test run`.

It is a config field rather than an argument because the refusal is read deep inside `expandSplices`, which every compile and check path reaches. `--agency-only` refuses splices too, but by taking a different compile path entirely, so the two do not imply one another — see `docs/dev/splices.md`.

## Flags that are NOT config

Not every flag becomes a setting, and forcing one to be a setting is a mistake.
There are three channels, and most new flags belong to one of the first two:

- **Config** (this document) — a value the compiler reads, or one that gets
  baked into the generated program. Goes through `applyCliFlags`.
- **Resolved objects passed as arguments** — `--policy` / `--approve` /
  `--reject` become an interrupt policy object via `resolveRunPolicy`,
  `--max-cost` / `--max-time` become a budget via `resolveBudget`, the test
  runner's output sink is a live object with methods, and `--agency-only`
  selects a different compile path (through the closure validator) rather than
  setting a value.
- **Forwarded verbatim to a child command line** — `agency doctor` accepts
  `--trace [file]` and `--log-file <path>` and translates neither. It pushes
  them back onto an argv for a child `agency` invocation (`lib/cli/doctor.ts`),
  where `applyCliFlags` runs in that process instead. A wrapper command that
  shells out belongs here, and the flag's meaning is still defined in exactly
  one place — just not in this one.

The test for which channel a flag belongs in: *is it a plain value the compiled
program needs baked in, or is it a live object, or a choice of code path, or is
this command a wrapper that re-invokes `agency`?* The first is config; the next
two are arguments; the last is forwarding. `agency run` and `agency test run`
both use the first two channels, which is expected, not drift.

## What `--model` means

`agency run --model` and the `agency <file>` shorthand set the run's default
model. The value is parsed by `resolveModelFlag` in `lib/cli/modelFlag.ts` and
mapped by `applyCliFlags`:

| you write | `client.defaultModel` | `client.defaultProvider` |
| --- | --- | --- |
| `gpt-5-mini` | `gpt-5-mini` | **deleted** |
| `anthropic/claude-opus-4-8` | `claude-opus-4-8` | `anthropic` |
| `openrouter/anthropic/claude-sonnet-4` | `anthropic/claude-sonnet-4` | `openrouter` |

The split is on the **first** slash only, which is what lets an OpenRouter model
identifier survive as the model name.

With no model anywhere (no flag, no `client.defaultModel`), codegen bakes
`DEFAULT_MODEL` and `DEFAULT_PROVIDER` from `lib/config.ts` together
(`gpt-5-mini` through `openai-responses`; the provider is named because the
inferred route for an OpenAI model is the base `openai` client, which has no
hosted web search). A configured model without a provider is baked alone, so
smoltalk infers the provider for the model the user named. The same constant
is the fallback in the memory manager, the optimizer's mutator, and
`SimpleOpenAIClient`. Note that the gpt-5 family rejects `temperature`; a
program that sets it must also name a model that accepts it.

Three things about this are easy to get wrong later.

**A bare model drops the provider rather than leaving it.** The code generator
emits a provider only when `client.defaultProvider` is truthy, so clearing it is
how smoltalk is allowed to infer the provider from the model name. If your
`agency.json` sets `defaultProvider` to route through a proxy, a bare `--model`
bypasses that proxy; name it (`--model litellm/gpt-4o-mini`) to keep it.

The mapping removes the key rather than setting it to `undefined`. Either would
satisfy the generator; removing it keeps the resolved config free of dangling
fields, which is what `agency config show` and any other consumer sees. The test
asserts the key is absent, so that contract cannot drift unnoticed.

**A stated provider is sticky.** The layers merge field by field
(`lib/runtime/state/context.ts` `getSmoltalkConfig`), so a provider set by the
flag survives a later `setModel("other")` in Agency code — the pair becomes that
provider plus the new model. Code that wants to move provider too must say
`setLlmOptions({ model, provider })`, or pass both per call. The precedence
cases in `lib/runtime/agencyLlm.test.ts` pin all four combinations.

**Only a bare name is validated.** It is checked against the hosted **text**
models from `_listHostedModels()` — not smoltalk's `getAllModels()`, which also
returns image, embedding and speech models. A prefixed name is never checked,
because `client.providerModules` can register a provider under any name at
startup, so at flag-parse time a custom provider and a typo are the same thing.
The escape for a model missing from the baked catalog is the prefix form; note
that `agency models refresh` prints JSON to stdout and persists nothing, so it
cannot affect a later process's validation.

## All options

### Basic

| Option | Type | Description |
|--------|------|-------------|
| `verbose` | `boolean` | Enable verbose compilation logging |
| `outDir` | `string` | Output directory for compiled TypeScript files |

### Type checking

| Option | Type | Description |
|--------|------|-------------|
| `strictTypes` | `boolean` | If true, untyped variables are errors instead of implicit `any` |
| `typeCheck` | `boolean` | Run the type checker during compilation (reports warnings) |
| `typeCheckStrict` | `boolean` | Make type errors fatal (implies `typeCheck: true`) |

### LLM and runtime

| Option | Type | Description |
|--------|------|-------------|
| `maxToolCallRounds` | `number` (positive int) | Max LLM-to-tool iterations before halting a tool loop (default: 10). Also `agency run/compile --max-tool-call-rounds <n>`, and at runtime via `setLlmOptions({ maxToolCallRounds })` / the agent's `--max-tool-call-rounds` flag. |
| (runtime only) `maxRepeatedToolCalls` | `number` | Refuse a tool call once the same call has returned the same result this many times in a row (default: 3; `0` disables). `llm(..., { maxRepeatedToolCalls })` and `setLlmOptions({ maxRepeatedToolCalls })`; not an `agency.json` key. See `docs/dev/tool-loop-guards.md`. |
| `client.maxToolResultChars` | `number` | Max chars of a single tool result fed back to the model (default: 100000; `0` disables). Also `--max-tool-result-chars <n>`, `llm(..., { maxToolResultChars })`, and `setLlmOptions({ maxToolResultChars })`. |
| `client.maxToolSchemaChars` | `number` | Warn (statelog `warn` event, `warnType: "toolSchemaSize"`) when one tool's serialized JSON schema exceeds this many characters (default: 2000; `0` disables). Warned once per tool name per run. Schemas ride on every request, so an oversized tool is a standing cost rather than a one-off. |
| `maxCallDepth` | `number` (positive int) | Max logical function-call nesting depth before the runaway-recursion guard throws `CallDepthExceededError` (default: 2048). Catches unbounded recursion — especially the async kind, which grows the promise chain until the process OOMs with no diagnostic — before it exhausts memory. Raise it for programs that legitimately recurse very deeply. Note: recursing through the stdlib higher-order functions (`map`/`filter`/`reduce`/`flatMap`) consumes ~2 depth levels per user level (the HOF call plus its callback dispatch), so the effective budget for HOF-style recursion is roughly half of what a `for`-loop equivalent gets. |
| `client` | `Partial<SmolConfig>` | Smoltalk client defaults — `logLevel`, `defaultModel`, `defaultProvider`, nested `apiKey`/`baseUrl` maps, and nested `statelog` config |

> **Breaking change (smoltalk 0.6.0):** the flat `client.openAiApiKey` /
> `googleApiKey` / `anthropicApiKey` fields are removed. Nest keys under
> `client.apiKey` instead — `{ "apiKey": { "openAi": "…", "anthropic": "…" } }`
> — and custom provider URLs under `client.baseUrl`. Each key still falls back
> to its conventional env var (`OPENAI_API_KEY`, etc.). See
> `guide/custom-providers` for the hosted providers and `defaultProvider`.

### Logging and tracing

| Option | Type | Description |
|--------|------|-------------|
| `log` | `Partial<StatelogConfig>` | Statelog configuration — `host`, `projectId`, `apiKey`, `debugMode`. See `docs/dev/statelog.md` |

### Security

| Option | Type | Description |
|--------|------|-------------|
| `restrictImports` | `boolean` | Validate that import paths resolve within the project directory, preventing path traversal attacks |


## Example

```json
{
  "verbose": false,
  "outDir": "dist",
  "maxToolCallRounds": 15,
  "strictTypes": true,
  "typeCheck": true,
  "restrictImports": true,
  "client": {
    "defaultModel": "gpt-4o",
    "logLevel": "error",
    "apiKey": { "openAi": "sk-...", "anthropic": "sk-ant-..." }
  },
  "log": {
    "host": "https://agency-lang.com",
    "projectId": "my-project"
  }
}
```
