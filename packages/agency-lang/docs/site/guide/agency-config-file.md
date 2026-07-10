---
name: Agency config file
description: A tour of the options you can set in an agency.json file to configure the Agency compiler and runtime.
---

# Agency config file

To set options, add an `agency.json` file to your project root. The compiler searches upward from the file you're running until it finds this file.

I would suggest referring to this page as needed, instead of reading it all the way through.

## The basics

```json
{
  "verbose": false,
  "logLevel": "info",
  "outDir": "./dist"
}
```

- **`verbose`** — extra logging during compilation.
- **`logLevel`** — `"debug"`, `"info"`, `"warn"`, or `"error"`.
- **`outDir`** — where compiled code goes (next to Agency source by default).

## LLM client

This is where you set your default model, provider, and API keys.

```json
{
  "client": {
    "defaultModel": "claude-fable-5",
    "defaultProvider": "anthropic",
    "apiKey": {
      "openAi": "sk-...",
      "anthropic": "sk-ant-..."
    },
  }
}
```

| Option | Description |
| --- | --- |
| `defaultModel` / `defaultProvider` | Used when a `llm()` call doesn't specify its own. |
| `apiKey` | Keys for `openAi`, `google`, `anthropic`, `ollama`, `openRouter`, `deepInfra`, `liteLlm`, and `openAiCompat`. |
| `baseUrl` | Needed if you're using a provider that provides an endpoint compatible with the OpenAI API, such as `openRouter`, `deepInfra`, `liteLlm` and others. |
| `maxToolResultChars` | Caps how much of a single tool result the model sees (the full value still reaches your code). Default `100000`; `0` disables it. Keeps a chatty tool from blowing the context window. |
| `providerModules` | Paths to custom smoltalk provider modules (e.g. a local model via `smoltalk-llama-cpp`). |
| `modelAliases` / `modelsDir` | Short-name aliases and the cache directory for local models. |

Agency uses [Smoltalk](https://github.com/egonSchiele/smoltalk) for its LLM client.

## Type checking

The typechecker is on by default.

```json
{
  "typechecker": {
    "enabled": true,
    "strict": true,
    "strictTypes": true,
    "undefinedFunctions": "warn"
  }
}
```

| Option | Description |
| --- | --- |
| `enabled` | Run the type checker and print warnings. Defaults to `true`. |
| `strict` | Type errors become fatal. Defaults to `true`. |
| `strictTypes` | Untyped variables are errors. |
| `undefinedFunctions` / `undefinedVariables` |  `"silent"`, `"warn"`, or `"error"` for undefined functions or variables. Both default to `"warn"`. |
| `strictMemberAccess` | Guards against accessing a member that only exists on some branches of a union. For example, if you had a [Result](/guide/error-handling) type, and you tried to access `result.value` (which only exists on Success), that would be an error. Default `"error"`. |
| `matchExhaustiveness` | Flags a `match` over a closed type that doesn't cover every case. For example, if you were matching over a variable with a union type like "success" | "failure", but you didn't handle the failure case, that would be an error. Default `"error"`. |
| `definiteReturns` | Flags a function that has a return type set, but not all of its code paths return a value. Default `"error"`. |

## Observability and logging

Turns on logging. See [Observability](/guide/observability) for details.

```json
{
  "observability": true,
  "log": {
    "logFile": "log.jsonl"
  }
}
```

## Memory

Enable the memory layer so agents can store and recall facts across runs. Setting this makes `std::memory` usable and lets `llm({ memory: true })` inject relevant facts. See [Memory](/guide/memory) for details.

```json
{
  "memory": {
    "dir": "./.agency-memory",
    "autoExtract": { "interval": 5 },
    "compaction": { "trigger": "token", "threshold": 8000 }
  }
}
```

| Option | Description |
| --- | --- |
| `dir` | Where memory JSON files live (required if you use `memory`). |
| `model` | Model used for extraction, compaction, and recall. |
| `autoExtract.interval` | How many turns to wait before running an auto-extraction on message history. Default `5`. |
| `compaction` | Controls when a conversation gets compacted. When the thread crosses `threshold`, Agency extracts facts from the older messages in the conversation, summarizes them with an LLM, and replaces them with a single summary message. Roughly the older half of the conversation is compacted. Use `trigger` to pick the metric: either `"token"` (estimated at roughly 4 characters per token) or `"messages"` (raw message count). Defaults to `trigger: "token"` and `threshold: 50000`. |
| `embeddings.model` | Embedding model for semantic recall. |

## Debugging and tracing

```json
{
  "trace": true
}
```

| Option | Description |
| --- | --- |
| `debugger` | Auto-inserts a breakpoint before every step. |
| `instrument` | Emit per-step instrumentation (default `true`). Set `false` to shed the overhead when you don't need tracing. |
| `trace` / `traceFile` / `traceDir` | Write execution checkpoints to a `.trace` file. |
| `distDir` | Directory of pre-compiled JS the debugger imports instead of compiling on the fly. |

## Runtime limits

Safety guards that stop a program from running away.

```json
{
  "maxCallDepth": 2048,
  "maxToolCallRounds": 10,
  "checkpoints": { "maxRestores": 100 }
}
```

| Option | Description |
| --- | --- |
| `maxCallDepth` | The runaway-recursion guard. Default `2048`; raise it for legitimately deep recursion. |
| `maxToolCallRounds` | How many times the LLM can loop between calling tools and reacting to their output before Agency halts it. Default `10`. |
| `checkpoints.maxRestores` | Cap on how often one checkpoint can be restored before it errors out. Default `100`. |

## Testing and coverage

```json
{
  "test": { "parallel": 4 },
  "coverage": {
    "threshold": 80,
    "perFileThreshold": 60,
    "exclude": ["examples/**"]
  }
}
```

| Option | Description |
| --- | --- |
| `test.parallel` | Number of test files to run at once. Default `1`. |
| `coverage.threshold` / `coverage.perFileThreshold` | Minimum coverage percentages; `agency coverage report` fails below them. |
| `coverage.outDir` | Where coverage data lands. |
| `coverage.exclude` | Which files to skip, as glob patterns (e.g. `["examples/**"]`). |

## Eval and optimize

Configuration for the `agency eval` and `agency eval optimize` commands.

```json
{
  "eval": {
    "runsDir": "./eval-runs",
    "optimize": {
      "goal": "Maximize accuracy",
      "graders": "./graders.ts",
      "validation": { "split": 0.2 }
    }
  }
}
```

| Option | Description |
| --- | --- |
| `runsDir` | Where `agency eval` saves its run artifacts. Default `runs`. |
| `optimizeRunsDir` | Where `agency eval optimize` saves its artifacts. Defaults to an `optimize` subdirectory inside `runsDir`. |
| `optimize.goal` | The optimization objective. |
| `optimize.graders` | Path to a TS grading module. |
| `optimize.optimizer` | A built-in optimizer name or a path to your own module. |
| `optimize.validation` | A validation inputs file and/or a `split` fraction held out for validation. |

## Docs, packing, and the log viewer

Odds and ends for other commands.

```json
{
  "doc": { "outDir": "docs", "baseUrl": "https://github.com/me/repo" },
  "pack": { "format": "esm", "target": "node20" },
  "viewer": { "slowMs": 5000, "expensiveUsd": 0.01 }
}
```

| Option | Description |
| --- | --- |
| `doc` | Output directory and source-link base URL for `agency doc`. |
| `pack` | Options for `agency pack`: output `format` (`"esm"` or `"cjs"`), esbuild `target` (e.g. `"node20"`), and `external`. `external` is an array of package names to exclude from the bundle and import at runtime instead (for packages that can't be bundled, like native addons). Anything marked external must already be installed wherever the bundle runs. |
| `viewer` | Color thresholds for `agency logs view`: `slowMs` and `fastMs` for durations, `expensiveUsd` for cost. |

## References
- [Full list of options](https://github.com/egonSchiele/agency-lang/blob/main/packages/agency-lang/lib/config.ts).
