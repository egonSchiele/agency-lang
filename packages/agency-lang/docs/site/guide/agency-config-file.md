---
name: Agency config file
description: A tour of the options you can set in an agency.json file to configure the Agency compiler and runtime.
---

# Agency config file

Drop an `agency.json` file in your project root and Agency picks it up automatically — the compiler searches upward from the file you're running until it finds one. Every option is optional, so you only set what you need.

Want a config somewhere else? Point at it with `-c`:

```bash
agency -c custom-config.json compile input.agency
```

The sections below cover the options worth knowing about. For the exhaustive list, the source of truth is [`lib/config.ts`](https://github.com/egonSchiele/agency-lang/blob/main/lib/config.ts).

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
- **`outDir`** — where compiled TypeScript goes.

## LLM client

This is where you set your default model, provider, and API keys. Keys live under `apiKey`, one per provider.

```json
{
  "client": {
    "defaultModel": "gpt-5",
    "defaultProvider": "openAi",
    "apiKey": {
      "openAi": "sk-...",
      "anthropic": "sk-ant-..."
    },
    "maxToolResultChars": 100000
  }
}
```

- **`defaultModel`** / **`defaultProvider`** — used when a `llm()` call doesn't specify its own.
- **`apiKey`** — keys for `openAi`, `google`, `anthropic`, `ollama`, `openRouter`, `deepInfra`, `liteLlm`, and `openAiCompat`.
- **`baseUrl`** — custom endpoints for the OpenAI-compatible-style providers (`openRouter`, `deepInfra`, `liteLlm`, `openAiCompat`).
- **`maxToolResultChars`** — caps how much of a single tool result the model sees (the full value still reaches your code). Default `100000`; `0` disables it. Keeps a chatty tool from blowing the context window.
- **`providerModules`** — paths to custom smoltalk provider modules (e.g. a local model via `smoltalk-llama-cpp`).
- **`modelAliases`** / **`modelsDir`** — short-name aliases and the cache directory for local models.

Also relevant here:

- **`maxToolCallRounds`** (top level) — how many times the LLM can loop between calling tools and reacting to their output before Agency halts it. Default `10`.

## Type checking

Off by default. Turn it on to catch problems at compile time.

```json
{
  "typechecker": {
    "enabled": true,
    "strictTypes": true,
    "undefinedFunctions": "warn"
  }
}
```

- **`enabled`** — run the type checker and print warnings.
- **`strict`** — type errors become fatal (implies `enabled`).
- **`strictTypes`** — untyped variables are errors.
- **`undefinedFunctions`** / **`undefinedVariables`** — `"silent"`, `"warn"`, or `"error"` for unresolved calls/references.
- **`strictMemberAccess`** — guards against reaching for a member that only exists on some branches of a union, like `r.value` on an un-narrowed `Result`. Default `"error"` — narrow first with a guard, `catch`, or `match`.
- **`matchExhaustiveness`** — flags a `match` over a closed type that doesn't cover every case and has no `_` arm. Default `"error"`.
- **`definiteReturns`** — flags a typed function that can fall off the end without returning (Agency has no implicit returns). Default `"warn"`.

## Sandboxing and security

Restrict what compiled code can do.

```json
{
  "allowedFetchDomains": ["api.openai.com", "api.example.com"],
  "disallowedFetchDomains": ["malicious.com"],
  "excludeBuiltinFunctions": ["write"]
}
```

- **`allowedFetchDomains`** — if set, `fetch`/`fetchJSON` may only hit these domains.
- **`disallowedFetchDomains`** — blocks these domains. If both lists are set, you get allowed-minus-disallowed.
- **`excludeBuiltinFunctions`** — strips built-ins like `write` or `fetch` from generated code entirely.

Heads up: domain checks only work on string-literal URLs at compile time — variable URLs can't be validated.

## Observability and logging

Structured event logging via [statelog](https://github.com/egonSchiele/agency-lang). It's a complete no-op until you flip `observability` on.

```json
{
  "observability": true,
  "log": {
    "host": "https://statelog.example.com",
    "projectId": "my-project",
    "logFile": "./events.jsonl"
  }
}
```

- **`observability`** — the master switch.
- **`log.host`** / **`log.projectId`** / **`log.apiKey`** — the remote sink.
- **`log.logFile`** — a local file sink (one JSON object per line); can run alongside `host`.
- **`log.requestTimeoutMs`** — how long to wait on a slow host before giving up. Default `1500`.
- **`log.metadata`** — tags, environment, userId, and custom fields attached to events.

## Memory

Enable the memory layer so agents can store and recall facts across runs. Setting this makes `std::memory` usable and lets `llm({ memory: true })` inject relevant facts.

```json
{
  "memory": {
    "dir": "./.agency-memory",
    "autoExtract": { "interval": 5 },
    "compaction": { "trigger": "token", "threshold": 8000 }
  }
}
```

- **`dir`** — where memory JSON files live (required if you use `memory`).
- **`model`** — model used for extraction, compaction, and recall.
- **`autoExtract.interval`** — LLM turns between auto-extraction passes. Default `5`.
- **`compaction`** — when to compact, triggered by `"token"` estimates or `"messages"` count.
- **`embeddings.model`** — embedding model for semantic recall.

## Debugging and tracing

```json
{
  "trace": true,
  "maxCallDepth": 2048
}
```

- **`debugger`** — auto-inserts a breakpoint before every step.
- **`instrument`** — emit per-step instrumentation (default `true`). Set `false` to shed the overhead when you don't need tracing.
- **`trace`** / **`traceFile`** / **`traceDir`** — write execution checkpoints to a `.trace` file.
- **`distDir`** — directory of pre-compiled JS the debugger imports instead of compiling on the fly.
- **`maxCallDepth`** — the runaway-recursion guard. Default `2048`; raise it for legitimately deep recursion.
- **`checkpoints.maxRestores`** — cap on how often one checkpoint can be restored before it errors out. Default `100`.

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

- **`test.parallel`** — number of test files to run at once. Default `1`.
- **`coverage.threshold`** / **`perFileThreshold`** — minimum coverage percentages; `agency coverage report` fails below them.
- **`coverage.outDir`** / **`exclude`** — where coverage data lands and which files to skip.

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

- **`runsDir`** / **`optimizeRunsDir`** — where run artifacts are saved.
- **`optimize.goal`** — the optimization objective.
- **`optimize.graders`** — path to a TS grading module.
- **`optimize.optimizer`** — a built-in optimizer name or a path to your own module.
- **`optimize.validation`** — a validation inputs file and/or a `split` fraction held out for validation.

## Docs, packing, and the log viewer

Odds and ends for other commands.

```json
{
  "doc": { "outDir": "docs", "baseUrl": "https://github.com/me/repo" },
  "pack": { "format": "esm", "target": "node20" },
  "viewer": { "slowMs": 5000, "expensiveUsd": 0.01 }
}
```

- **`doc`** — output directory and source-link base URL for `agency doc`.
- **`pack`** — output `format` (`"esm"` or `"cjs"`), esbuild `target`, and extra `external` specifiers for `agency pack`.
- **`viewer`** — color thresholds for `agency logs view`: `slowMs` and `fastMs` for durations, `expensiveUsd` for cost.
