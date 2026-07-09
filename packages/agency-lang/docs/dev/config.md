# AgencyConfig

## Overview

`AgencyConfig` (`lib/config.ts`) defines all compiler and runtime configuration options for Agency. It is typically loaded from an `agency.json` file in the project root, but can also be passed programmatically. The CLI accepts a `-c` / `--config` flag to specify a custom config file path.

For basic usage examples, see `docs/config.md`.

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
| `maxToolCallRounds` | `number` | Max LLM-to-tool iterations before halting (default: 10) |
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
