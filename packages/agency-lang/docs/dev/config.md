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
| `client.maxToolResultChars` | `number` | Max chars of a single tool result fed back to the model (default: 100000; `0` disables). Also `--max-tool-result-chars <n>`, `llm(..., { maxToolResultChars })`, and `setLlmOptions({ maxToolResultChars })`. |
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
