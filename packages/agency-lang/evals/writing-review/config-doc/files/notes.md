# AgencyConfig

## Overview

`AgencyConfig` (`lib/config.ts`) defines all compiler and runtime configuration options for Agency. It is typically loaded from an `agency.json` file in the project root, but can also be passed programmatically. The CLI accepts a `-c` / `--config` flag to specify a custom config file path.

For basic usage examples, see [`docs/misc/config.md`](../../misc/config.md).

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

It is a config field rather than an argument because the refusal is read deep
inside `expandSplices`, which every compile and check path reaches.
`--agency-only` refuses splices too, but by taking a different compile path
entirely, so the two do not imply one another — see
`docs/dev/language/splices.md`.

One consequence of being a config field is worth knowing, because it bit this
flag once. Anything that merges another config **over** the CLI-derived one can
cancel it. `agency test run` does exactly that: both `groupTestSources`
(`lib/cli/precompile.ts`) and `runTestFile` (`lib/cli/test.ts`) merge a
fixture-local `agency.json` over the base, so a fixture carrying
`"refuseSplices": false` beat the flag until both sites were changed to
re-apply the CLI intent afterwards. Every other command is safe for free,
because `applyCliFlags` runs last there. If you add a flag whose whole point is
to refuse something, check that nothing merges over it, and note that a
subprocess re-derives its own config — `expectedCompileError` shells out to a
child `agency compile`, which has to be passed the flag explicitly.

## All options

Every field is optional, and the schema is `.loose()`, so an unknown key in
`agency.json` loads rather than erroring. The list below follows the
`AgencyConfig` interface and `AgencyConfigSchema` in `lib/config.ts`; read
those for the full per-field commentary.

### Basic

| Option                     | Type                                     | Description                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verbose`                  | `boolean`                                | Enable verbose compilation logging                                                                                                                                                                 |
| `logLevel`                 | `"debug" \| "info" \| "warn" \| "error"` | Compiler log level                                                                                                                                                                                 |
| `outDir`                   | `string`                                 | Output directory for compiled files                                                                                                                                                                |
| `distDir`                  | `string`                                 | Directory of pre-compiled JS. The debugger imports from here instead of compiling on the fly.                                                                                                      |
| `allowNonAgencyGenerators` | `boolean`                                | Let a compile-time splice generator import JavaScript. Off by default, because a generator that reaches an npm package is unchecked. See [`docs/dev/language/splices.md`](../language/splices.md). |
| `instrument`               | `boolean`                                | Emit `debugStep()` instrumentation in compiled output (default: true)                                                                                                                              |
| `debugger`                 | `boolean`                                | Inert. `agency debug` sets it, but nothing reads it. `instrument` is the flag that controls `debugStep()` emission.                                                                                |

### Type checking

Type-checker settings live under `typechecker`, not at the top level.

| Option                            | Type                            | Description                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typechecker.enabled`             | `boolean`                       | Run the type checker during compilation and print warnings (default: false)                                                                                                                                   |
| `typechecker.strict`              | `boolean`                       | Type errors are fatal, which implies `enabled` (default: false)                                                                                                                                               |
| `typechecker.strictTypes`         | `boolean`                       | Untyped variables are errors instead of implicit `any` (default: false)                                                                                                                                       |
| `typechecker.undefinedFunctions`  | `"silent" \| "warn" \| "error"` | An unresolvable function call (default: `warn`)                                                                                                                                                               |
| `typechecker.undefinedVariables`  | `"silent" \| "warn" \| "error"` | An unresolvable variable reference (default: `silent`)                                                                                                                                                        |
| `typechecker.strictMemberAccess`  | `"silent" \| "warn" \| "error"` | A property that exists on only some members of an un-narrowed union (default: `error`)                                                                                                                        |
| `typechecker.matchExhaustiveness` | `"silent" \| "warn" \| "error"` | A `match` over a closed type that misses a case and has no `_` arm (default: `"error"`). Only statement match sites honor this value. An expression match is hard-checked per site regardless of the setting. |
| `typechecker.definiteReturns`     | `"silent" \| "warn" \| "error"` | A function with a non-void return type can reach the end of its body without returning (default: `warn`)                                                                                                      |

### LLM and runtime

| Option                                | Type                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxToolCallRounds`                   | `number` (positive int)   | Max LLM-to-tool iterations before halting a tool loop (default: 10). Also `agency run/compile --max-tool-call-rounds <n>`, and at runtime via `setLlmOptions({ maxToolCallRounds })` / the agent's `--max-tool-call-rounds` flag.                                                                                                                                                                                                                                                                                                                                                                      |
| (runtime only) `maxRepeatedToolCalls` | `number`                  | Refuse a tool call once the same call has returned the same result this many times in a row (default: 3; `0` disables). `llm(..., { maxRepeatedToolCalls })` and `setLlmOptions({ maxRepeatedToolCalls })`; not an `agency.json` key. See [`docs/dev/agents/tool-loop-guards.md`](../agents/tool-loop-guards.md).                                                                                                                                                                                                                                                                                      |
| `client.maxToolResultChars`           | `number`                  | Max chars of a single tool result fed back to the model (default: 100000; `0` disables). Also `--max-tool-result-chars <n>`, `llm(..., { maxToolResultChars })`, and `setLlmOptions({ maxToolResultChars })`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `client.maxToolSchemaChars`           | `number`                  | Warn (statelog `warn` event, `warnType: "toolSchemaSize"`) when one tool's serialized JSON schema exceeds this many characters (default: 2000; `0` disables). Warned once per tool name per run. Schemas ride on every request, so an oversized tool is a standing cost rather than a one-off.                                                                                                                                                                                                                                                                                                         |
| `maxCallDepth`                        | `number` (positive int)   | Max logical function-call nesting depth before the runaway-recursion guard throws `CallDepthExceededError` (default: 2048). Catches unbounded recursion, especially the async kind, which grows the promise chain until the process OOMs with no diagnostic. Raise it for programs that legitimately recurse very deeply. Note: recursing through the stdlib higher-order functions (`map`/`filter`/`reduce`/`flatMap`) consumes ~2 depth levels per user level, one for the call and one for the callback dispatch, so HOF-style recursion gets roughly half the budget a `for`-loop equivalent gets. |
| `failurePropagation`                  | `"off" \| "warn" \| "on"` | How a failure value passed where a Result is not accepted behaves (default: `on`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `checkpoints.maxRestores`             | `number`                  | Max restores of a single checkpoint before `CheckpointError` (default: 100)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `budget.maxCost`                      | `number`                  | Dollars of LLM spend for the run. `< 0` disables, `0` is a real limit. Must be finite. A `--max-cost` flag wins over it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `budget.maxTime`                      | `string`                  | Duration string such as `30s`, `5m`, `1h`. `<= 0` disables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `memory`                              | object                    | Enables the memory layer: `dir`, `model`, `autoExtract.interval`, `compaction.trigger`/`threshold`, `embeddings.model`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `client`                              | `Partial<SmolConfig>`     | Smoltalk client defaults: `logLevel`, `defaultModel`, `defaultProvider`, the `apiKey` and `baseUrl` per-provider maps, `providerModules`, `modelAliases`, `modelsDir`, and a nested `statelog` block                                                                                                                                                                                                                                                                                                                                                                                                   |

> **Breaking change (smoltalk 0.6.0):** the flat `client.openAiApiKey` /
> `googleApiKey` / `anthropicApiKey` fields are removed. Nest keys under
> `client.apiKey` instead — `{ "apiKey": { "openAi": "…", "anthropic": "…" } }`
> — and custom provider URLs under `client.baseUrl`. Each key still falls back
> to its conventional env var (`OPENAI_API_KEY`, etc.). See
> `guide/custom-providers` for the hosted providers and `defaultProvider`.

### Logging and tracing

| Option          | Type      | Description                                                                                                                                                                                            |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `observability` | `boolean` | Activate statelog. When false (the default) the StatelogClient is a complete no-op: no events, no network calls.                                                                                       |
| `log`           | object    | Statelog configuration: `host`, `projectId`, `apiKey`, `debugMode`, `logFile`, `requestTimeoutMs` (default 1500), `metadata`, and `code`. See [`docs/dev/hosting/statelog.md`](../hosting/statelog.md) |
| `trace`         | `boolean` | Write an execution trace                                                                                                                                                                               |
| `traceFile`     | `string`  | Trace file path (default: `<program>.trace`)                                                                                                                                                           |
| `traceDir`      | `string`  | Directory for auto-generated `<timestamp>_<id>.agencytrace` files                                                                                                                                      |
| `viewer`        | object    | Thresholds for `agency logs view`: `slowMs` (5000), `fastMs` (100), `expensiveUsd` (0.01)                                                                                                              |

### Commands

| Option                       | Type     | Description                                                                                                                                                                               |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test.parallel`              | `number` | Test files to run in parallel (default: 1)                                                                                                                                                |
| `doc.outDir` / `doc.baseUrl` | `string` | Output directory and source-link base URL for `agency doc`                                                                                                                                |
| `coverage`                   | object   | `outDir`, `threshold`, `perFileThreshold`, `exclude`                                                                                                                                      |
| `pack`                       | object   | `format` (`esm`/`cjs`), `target`, `external`                                                                                                                                              |
| `eval`                       | object   | `runsDir`, `optimizeRunsDir`, `sourceCacheRoot`, `limits.wallClockSec`, `limits.maxCostUsd`, and the `optimize` block. See [`docs/dev/evals/eval-tracking.md`](../evals/eval-tracking.md) |
| `remote.serveUrl`            | `string` | The hosted agent this directory is linked to                                                                                                                                              |

## Example

```json
{
  "verbose": false,
  "outDir": "dist",
  "maxToolCallRounds": 15,
  "typechecker": {
    "enabled": true,
    "strictTypes": true
  },
  "client": {
    "defaultModel": "gpt-4o",
    "logLevel": "error",
    "apiKey": { "openAi": "sk-...", "anthropic": "sk-ant-..." }
  },
  "observability": true,
  "log": {
    "host": "https://agency-lang.com",
    "projectId": "my-project"
  }
}
```
