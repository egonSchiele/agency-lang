# Unit Literals Design Spec

## Summary

Unit literals are compile-time syntactic sugar that let you write `30s`, `500ms`, `2h`, `$5.00`, etc. in Agency code. They normalize to plain numbers at compile time, providing clarity at the source level with zero runtime cost.

## Motivation

Agency's stdlib has time-related functions that each use different units:

- `sleep(seconds)` — takes seconds
- `exec(..., timeout)` and `bash(..., timeout)` — take seconds
- `browserUse(..., timeoutMs)` — takes milliseconds
- `addMinutes(datetime, minutes)` — takes minutes
- `addHours(datetime, hours)` — takes hours
- `addDays(datetime, days)` — takes days

This is confusing. You have to remember what unit each function expects. Unit literals solve this by making the unit explicit at the call site, and by enabling a unified `add` function in the date stdlib.

## Syntax

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

Cost units are included in this spec because they share the same parsing and codegen infrastructure. They'll be used by the guards feature (separate spec), but the literal syntax itself is general-purpose.

### Decimals

Decimal values are supported: `0.5s` -> `500`, `$2.50` -> `2.50`.

## Compile-time normalization

Unit literals compile to plain numbers. No new runtime types, no overhead:

```ts
sleep(1s)         // compiles to: sleep(1000)
sleep(500ms)      // compiles to: sleep(500)
const t = 30s     // compiles to: const t = 30000
```

## Unit math

Because both sides normalize to the same canonical unit (milliseconds), arithmetic and comparisons just work with no special operator support:

```ts
1s + 500ms       // 1000 + 500 = 1500
2s * 3           // 2000 * 3 = 6000
if (elapsed > 30s) { ... }  // if (elapsed > 30000) { ... }
```

## Dimension mismatch detection

The typechecker prevents mixing time and cost dimensions:

```ts
1s + $5.00    // ERROR: cannot add time and cost
30s > $2.00   // ERROR: cannot compare time and cost
```

A dimensioned value combined with a plain number is allowed (e.g. `30s * 2` is fine — it's multiplying milliseconds by a scalar).

The result type of any unit expression is `number`. This is a lightweight compile-time check, not a full unit type system.

## Stdlib changes

### Canonical unit: milliseconds

All stdlib functions that accept time values should be migrated to accept **milliseconds** as their canonical unit. This is the JS convention (`setTimeout`, `Date.getTime()`, etc.) and matches the canonical unit for time literals.

### sleep

**Before:** `sleep(seconds: number)` — takes seconds
**After:** `sleep(ms: number)` — takes milliseconds

```ts
// old
sleep(1)

// new
sleep(1s)
sleep(1000)     // also works — it's just a number
```

The underlying implementation changes from `setTimeout(resolve, seconds * 1000)` to `setTimeout(resolve, ms)`.

### exec and bash

**Before:** `exec(..., timeout: number)` and `bash(..., timeout: number)` — take seconds
**After:** `exec(..., timeout: number)` and `bash(..., timeout: number)` — take milliseconds

```ts
// old
exec("ls", args: ["-la"], timeout: 30)

// new
exec("ls", args: ["-la"], timeout: 30s)
exec("ls", args: ["-la"], timeout: 30000)  // also works
```

### browserUse

**Before:** `browserUse(..., timeoutMs: number)` — takes milliseconds (already canonical!)
**After:** `browserUse(..., timeout: number)` — rename for consistency, still milliseconds

```ts
browserUse(task: "Click the button", timeout: 2m)
```

### Date: unified `add` function

**New function:** `add(datetime: string, duration: number): string`

Takes a datetime string and a duration in milliseconds, returns a new ISO 8601 datetime string.

```ts
import { now, add } from "std::date"

const inTwoHours = add(now(), 2h)
const nextWeek = add(now(), 7d)
const in90min = add(now(), 90m)
const meetingEnd = add(start, 1h)
```

The existing `addMinutes`/`addHours`/`addDays` functions remain for backwards compatibility.

### Summary of stdlib changes

| Function | Before | After |
|----------|--------|-------|
| `sleep(n)` | seconds | milliseconds |
| `exec(..., timeout: n)` | seconds | milliseconds |
| `bash(..., timeout: n)` | seconds | milliseconds |
| `browserUse(..., timeoutMs: n)` | milliseconds (renamed param) | milliseconds (param renamed to `timeout`) |
| `add(datetime, n)` | (new function) | milliseconds |

## Breaking changes

Changing `sleep`, `exec`, and `bash` from seconds to milliseconds is a breaking change. Existing code like `sleep(1)` would sleep for 1ms instead of 1s.

Mitigation options:
1. **Just break it.** Agency is pre-1.0, and the new behavior is better. Users update `sleep(1)` to `sleep(1s)`.
2. **Deprecation warning.** If a plain number (no unit suffix) is passed to these functions, emit a compiler warning suggesting unit literals. Remove the warning after a release cycle.
3. **Keep both.** Add new `sleepMs` etc. alongside the old functions. (Not recommended — defeats the purpose of standardizing.)

Recommended: **Option 1**. Agency is pre-1.0 and this is a clear improvement. Document the breaking change in release notes.

## Agency generator (formatter)

The Agency generator (`AgencyGenerator`) formats `.agency` files. It needs a case for the `unitLiteral` AST node type so that unit literals round-trip correctly through parse -> format.

The generator should reconstruct the original literal from the AST node's `value` and `unit` fields:

- `{ value: "30", unit: "s" }` -> `30s`
- `{ value: "5.00", unit: "$" }` -> `$5.00`
- `{ value: "500", unit: "ms" }` -> `500ms`

For cost literals, the `$` goes before the number. For time literals, the suffix goes after.

The generator must NOT emit the canonical value (e.g. `30000` for `30s`). The whole point is preserving the author's intent.

## Documentation

Update `docs-new/guide/basic-syntax.md` to include a section on unit literals. This belongs in basic syntax because units are a fundamental numeric literal feature, not specific to guards or any other construct.

The section should cover:
- Supported units (time: `ms`, `s`, `m`, `h`, `d`, `w`; cost: `$`)
- What they compile to (plain numbers, compile-time normalization)
- Unit math (`1s + 500ms`)
- Dimension mismatch errors (`1s + $5.00`)

Also update the date stdlib module docstring (`stdlib/date.agency`) to show the new `add()` function with unit literal examples.

## Non-goals

- User-defined units (only time and cost, fixed set)
- Full unit-of-measure type system (just compile-time normalization)
- Runtime unit tracking (units are erased at compile time)
- Compound units like `m/s` (not needed for Agency's domain)
