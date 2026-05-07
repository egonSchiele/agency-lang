# Guards Design Spec

## Summary

Guards are a new block-level construct that enforce resource limits (cost, timeout, call depth) on a section of Agency code. When a limit is exceeded, the guard either interrupts (for cost) or returns a failure (for timeout/depth), giving the user control over how to handle resource overruns.

## Motivation

Agency already tracks token usage and cost at runtime, and has `maxToolCallRounds` and `maxRestores` as config options. But there's no way for users to set budgets on arbitrary sections of code and react when they're exceeded. Guards fill this gap with a composable, block-scoped construct that integrates with Agency's existing interrupt and Result systems.

## Syntax

```ts
guard (cost: $5.00, timeout: 30s, depth: 10) {
  const result = llm("Write me an essay")
  print(result)
}
```

All three parameters are optional — use whichever limits you need:

```ts
guard (timeout: 10s) {
  const result = llm("Quick question")
}

guard (cost: $0.50, depth: 5) {
  const result = llm("Do something complex", { tools: [myTool] })
}
```

Guards return the value of their block on success, or a failure if a timeout/depth limit is triggered.

## Guard types and behavior

| Guard | What it measures | Trigger behavior | Rationale |
|-------|-----------------|------------------|-----------|
| `cost` | Dollar cost of LLM calls within the block | **Interrupt** | "Should I keep going?" is a meaningful question the user/handler can answer |
| `timeout` | Wall-clock time elapsed since block entry | **Failure** | Time already passed, nothing to approve |
| `depth` | Recursive call depth / LLM call rounds within the block | **Failure** | Likely infinite loop, approving "keep going" is rarely correct |

### Cost guard (interrupt)

When cumulative cost within the guard block exceeds the limit, an interrupt is thrown. This interrupt is composable with handlers:

```ts
handle {
  guard (cost: $5.00) {
    llm("expensive task")
  }
} with (data) {
  // data contains: { guard: "cost", limit: 5.00, actual: 5.23 }
  if (data.actual < 6.00) {
    return approve()
  }
  return reject()
}
```

If rejected (or propagated to user and rejected), the guard block returns a failure.

### Timeout guard (failure)

When wall-clock time exceeds the limit, the current operation is cancelled and the guard block returns a failure with a checkpoint:

```ts
const result = guard (timeout: 30s) {
  llm("Write a novel")
} catch "Took too long, here's a shorter version"
```

### Depth guard (failure)

When LLM call rounds or recursive depth exceeds the limit, the guard block returns a failure:

```ts
const result = guard (depth: 5) {
  llm("Solve this step by step", { tools: [solveTool] })
}
```

## Failure value

Guard failures use the standardized failure format with a `data` field:

```ts
type ResultFailure = {
  __type: "resultType";
  success: false;
  error: string;                      // always a string
  data: Record<string, any> | null;   // structured metadata
  checkpoint: any;
  retryable: boolean;
  functionName: string | null;
  args: Record<string, any> | null;
};
```

Guard-specific failure data:

```ts
// timeout failure
{ guard: "timeout", limit: 30000, actual: 31542 }

// depth failure
{ guard: "depth", limit: 10, actual: 11 }

// cost failure (if rejected after interrupt)
{ guard: "cost", limit: 5.00, actual: 5.23 }
```

Users can also attach metadata to their own failures:

```ts
failure("Something went wrong", { code: 42, context: "during parsing" })
```

## Nesting

Guards are nestable. Inner guards apply to their own scope, and cost accumulates upward:

```ts
guard (cost: $10.00) {
  guard (cost: $5.00) {
    // inner block can spend at most $5
    llm("Task A")
  }
  // remaining outer budget = $10 minus whatever inner block spent
  llm("Task B")
}
```

For timeout, inner and outer are independent wall-clock limits. The outer timeout covers everything including time spent in inner blocks:

```ts
guard (timeout: 30s) {
  guard (timeout: 10s) {
    // inner block fails after 10s
    llm("Quick task")
  }
  // outer block still has its own 30s total limit
  llm("Another task")
}
```

## Unit literals

Guards use unit literals for clarity. These are compile-time syntactic sugar that normalize to canonical numeric values. Unit literals are useful beyond guards — they work anywhere a number is expected (e.g. `sleep(1s)`, `addMinutes(start, 60m)`).

### Time units

| Literal | Canonical (milliseconds) | Example |
|---------|-------------------------|---------|
| `Nms` | N | `500ms` -> `500` |
| `Ns` | N * 1000 | `30s` -> `30000` |
| `Nm` | N * 60,000 | `5m` -> `300000` |
| `Nh` | N * 3,600,000 | `2h` -> `7200000` |
| `Nd` | N * 86,400,000 | `7d` -> `604800000` |
| `Nw` | N * 604,800,000 | `1w` -> `604800000` |

### Cost units

| Literal | Canonical (base currency unit) | Example |
|---------|-------------------------------|---------|
| `$N` | N | `$5.00` -> `5.00` |

### Compile-time normalization

Unit literals are purely compile-time. They compile down to plain numbers:

```ts
guard (timeout: 30s) { ... }
// compiles to equivalent of: guard({ timeout: 30000 }) { ... }

sleep(1s)
// compiles to: sleep(1000)
```

### Unit math

Because both sides normalize to the same canonical unit, arithmetic and comparisons just work:

```ts
1s + 500ms       // 1000 + 500 = 1500
2s * 3           // 2000 * 3 = 6000
if (elapsed > 30s) { ... }  // if (elapsed > 30000) { ... }
```

### Dimension mismatch

The typechecker prevents mixing dimensions:

```ts
1s + $5.00    // ERROR: cannot add time and cost
30s > $2.00   // ERROR: cannot compare time and cost
```

This is a lightweight compile-time check, not a full unit type system. The result type of any unit expression is just `number`.

### Supported dimensions

Only two dimensions are supported (intentionally minimal):

- **Time**: `ms`, `s`, `m` (minutes), `h` (hours), `d` (days), `w` (weeks)
- **Cost**: `$`

This is a fixed set — no user-defined units. If more dimensions are needed in the future, they can be added to the language.

### Stdlib implications

With unit literals, the date stdlib can offer a single `add` function instead of separate `addMinutes`/`addHours`/`addDays`:

```ts
import { now, add } from "std::date"

const inTwoHours = add(now(), 2h)
const nextWeek = add(now(), 7d)
const in90min = add(now(), 90m)
const meetingEnd = add(start, 1h)
```

The existing `addMinutes`/`addHours`/`addDays` functions remain for backwards compatibility, but `add` with unit literals is the preferred API going forward.

## Interaction with existing features

### With `catch`

```ts
const result = guard (timeout: 30s) {
  llm("Write a novel")
} catch "Operation timed out"
```

### With `handle...with`

Cost guard interrupts flow through the handler chain like any other interrupt:

```ts
handle {
  guard (cost: $5.00) {
    llm("expensive task")
  }
} with (data) {
  return reject()  // hard stop on any cost overrun
}
```

### With `fork`

Each fork branch gets its own guard scope. A guard wrapping a fork applies to the total cost/time across all branches:

```ts
guard (cost: $10.00, timeout: 60s) {
  fork(tasks) as task {
    llm("Process ${task}")
  }
}
```

### With pipe operator

```ts
const result = guard (timeout: 10s) {
  success(data) |> step1 |> step2 |> step3
}
```

If the timeout fires mid-pipe, the guard returns a failure.

## Standardized failure type (breaking change)

The `error` field on `ResultFailure` is changed from `any` to `string`. A new `data` field is added for structured metadata:

**Before:**
```ts
failure(error: any, opts?: { checkpoint?, retryable?, functionName?, args? })
```

**After:**
```ts
failure(error: string, data?: Record<string, any>)
```

The `checkpoint`, `retryable`, `functionName`, and `args` fields are still populated by the runtime automatically. The `data` field is user-facing — it's what users pass as the second argument and what guards populate with their metadata.

## Configuration

Guards can also be set globally via `agency.json` as defaults that apply to all execution:

```json
{
  "guards": {
    "cost": 50.00,
    "timeout": 300000,
    "depth": 20
  }
}
```

Block-level guards override (use the stricter of the two). Global guards act as a safety net.

## Non-goals

- Custom user-defined guard types (keep it simple: cost, timeout, depth)
- Middleware / prompt inspection (different concept)
- Per-model cost tracking (track aggregate cost only)
- Full unit-of-measure type system (just compile-time normalization for a fixed set)
