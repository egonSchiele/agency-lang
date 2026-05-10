# Subprocess Resource Limits: Design Spec

## Overview

Add per-call resource limits to `std::agency`'s `run()` function so a parent
agent can constrain wall-clock time, memory, IPC payload size, and
stdout/stderr volume of a subprocess it spawns.

The limits protect the parent's availability against runaway subprocesses —
agent-generated code that loops forever, allocates unbounded memory, or
returns gigantic results. They are *not* a security boundary against
malicious subprocess code (see
[2026-05-07-subprocess-ipc-handler-propagation-design.md](./2026-05-07-subprocess-ipc-handler-propagation-design.md)
and the security review for the broader sandboxing story).

## Motivation

Today, `run()` has no resource limits. A subprocess that hangs leaves the
parent's `_run` Promise unresolved indefinitely. A subprocess that returns a
1 GB string OOMs the parent. A subprocess that floods stdout fills the
parent's terminal. None of these require malice — a buggy LLM-generated loop
is enough.

The parent's handler chain doesn't help here, because runaway behavior
doesn't go through the interrupt mechanism. Limits are the right tool: they
give the parent a guaranteed bound on what a subprocess can consume,
regardless of what the subprocess code does.

## API

`run()` becomes a flat-parameter function so each limit can be partially
applied independently. This composes with Agency's named arguments and
[partial application](../../docs-new/guide/partial-application.md), letting a
parent constrain the dangerous knobs and hand the constrained version to an
LLM as a tool.

```ts
def run(
  compiled: CompiledProgram,
  node: string,
  args: object,
  wallClock: number = 60s,
  memory: number = 512mb,
  ipcPayload: number = 100mb,
  stdout: number = 1mb,
): Result
```

This is a **breaking change** from the current
`run(compiled, { node, args })` shape. The few in-tree test fixtures that use
the old shape will be updated in the same PR.

### Composition with partial application

The intended usage pattern:

```ts
// Parent constrains the dangerous knobs, exposes the rest
const safeRun = run.partial(
  compiled: compiled,
  wallClock: 5s,
  memory: 128mb,
)

// LLM gets a tool with constrained limits — it can only fill in node/args
const result = llm("Run this agent", { tools: [safeRun] })
```

This mirrors the constrained-API pattern documented in the
partial-application guide, but applied to resource safety.

## Defaults and caps

Each limit has both a **default** (used when the caller doesn't specify) and
a **hardcoded absolute maximum** (the runtime clamps any user-supplied value
to this ceiling, regardless of source). Defaults are conservative-but-loose
to avoid breaking common usage; ceilings are "almost certainly a runaway"
thresholds.

| Limit       | Default  | Hardcoded ceiling |
| ----------- | -------- | ----------------- |
| wallClock   | 60s      | 1h                |
| memory      | 512mb    | 4gb               |
| ipcPayload  | 100mb    | 1gb               |
| stdout      | 1mb      | 100mb             |

Caps are enforced at the top of `_run` by clamping any value greater than the
ceiling to the ceiling, and emitting an `ipcLog` warning so the user knows
their value was reduced. This protects against typos (`wallClock: 1000h`) and
deliberate-but-misguided misuse without requiring a config file.

A future design may add config-file caps in `agency.json` for deployers who
need to enforce policy across multiple Agency programs (see Non-goals).

## Byte unit literals

A small language extension: add `b`, `kb`, `mb`, `gb` byte unit literals,
parallel to the existing `s`/`ms`/`m`/`h` time literals. They normalize to
**bytes** at compile time (matching how time normalizes to its smallest
unit, ms).

```ts
const a = 1mb        // 1_048_576
const b = 100mb      // 104_857_600
const c = 4gb        // 4_294_967_296
const d = 512mb + 100kb  // unit math works
```

Mixing dimensions is a type error, same as today for time + cost.

This change is bigger than the rest of the spec because it touches the lexer
and unit-literal compiler. Implementation lives in the same files as the
current time-literal handling.

## Enforcement per limit

| Limit       | Mechanism |
| ----------- | --------- |
| wallClock   | `setTimeout` in parent; `child.kill("SIGKILL")` on expiry. |
| memory      | `--max-old-space-size=<mb>` flag passed to `fork(...)` via `execArgv`. Caps V8 heap. Subprocess crashes with OOM if exceeded; parent sees abnormal close and converts to a `limit_exceeded` failure. Does not cap native buffers; tightening to RSS would need a native module — deferred. |
| ipcPayload  | Parent checks `JSON.stringify(msg).length` on every `child.on("message")` event. Child also checks before sending its result; if exceeded, sends an error message instead. Hard fail; no truncation. |
| stdout      | Switch `stdio` from `"inherit"` to `"pipe"` for fds 1 and 2. Parent counts bytes per stream and pipes through to its own stdout/stderr. On exceeding limit, append `\n... [N bytes truncated]\n`, stop forwarding further bytes, kill subprocess, return `limit_exceeded` failure. |

## Violation behavior

When any limit is exceeded:

1. Subprocess is killed with `SIGKILL` (if not already exiting).
2. Temp dir is cleaned up (existing logic).
3. `run()` returns:

```ts
failure({
  reason: "limit_exceeded",
  limit: "wall_clock",       // or "memory", "ipc_payload", "stdout"
  threshold: 60000,
  value: 60123,              // observed value when violation detected
  message: "Subprocess exceeded wall-clock limit of 60s (used 60.123s)"
})
```

The structured fields let parent code pattern-match in handlers, e.g.
`if (data.reason == "limit_exceeded" && data.limit == "memory") { ... }`.

For IPC payload, the failure value also includes a `samplePrefix` field with
the first 1 KB of the offending payload, so the user can see what shape the
runaway data was without committing to type-corrupting truncation.

## Observability

Every limit violation is observable from two channels:

1. **`ipcLog` line on the parent** (always, even without
   `AGENCY_IPC_DEBUG`):
   ```
   [ipc:parent] HH:MM:SS.mmm limit_exceeded kind=wall_clock value=60123 threshold=60000
   ```
2. **Failure value** returned by `run()` — same structured info.

When `AGENCY_IPC_DEBUG=1` is set, each violation also dumps cumulative usage
at the time of detection (peak memory if known, IPC bytes so far, stdout
bytes so far). This lets the user decide whether to bump the limit or fix a
runaway subprocess from log evidence alone.

## Implementation plan (rough)

1. **Byte unit literals** — extend the lexer/parser/unit table to recognize
   `b`/`kb`/`mb`/`gb` and normalize to bytes.
2. **Update `run()` signature in `stdlib/agency.agency`** — flat params with
   defaults, breaking change. Update all in-tree callers (test fixtures).
3. **Cap clamping** — at top of `_run` in `lib/runtime/ipc.ts`, clamp each
   limit to its hardcoded ceiling and `ipcLog` if reduced.
4. **Wall-clock enforcement** — `setTimeout` + `child.kill("SIGKILL")`.
5. **Memory enforcement** — `execArgv: [`--max-old-space-size=${memoryMb}`]`
   on `fork()`. Convert OOM exit to `limit_exceeded` in close handler.
6. **Stdout/stderr enforcement** — switch `stdio` to `"pipe"` for fds 1/2;
   add a counting Transform stream per fd; kill on threshold exceeded.
7. **IPC payload enforcement** — wrap `process.send` on the child to check
   stringify length; check on parent's `child.on("message")` handler.
8. **Failure shape** — extend `_run`'s rejection paths to construct
   `limit_exceeded` failures with the structured fields.
9. **Tests** — one Agency test fixture per limit dimension that exercises
   the violation path and asserts the failure shape. Plus a flat-API test
   that uses partial application to constrain limits.

## Non-goals

- **Config-file caps** (`agency.json` policy section that overrides per-call
  options). Useful when callers are partially untrusted; not needed in v1.
  The hardcoded ceilings cover the immediate need.
- **RSS-based memory limits**. `--max-old-space-size` covers V8 heap; native
  buffers and out-of-heap allocations slip through. Tightening would need
  `process.memoryUsage().rss` polling or a native `setrlimit` module.
  Deferred until there's evidence this matters.
- **CPU-time limits**. Wall-clock already gives an upper bound (CPU ≤
  wall-clock). The only case where CPU < wall-clock is when the subprocess
  is waiting on I/O — but waiting on LLM calls is what an Agency subprocess
  spends most of its time doing, so CPU and wall-clock track each other in
  practice. The "compute-bound infinite loop" failure mode that CPU limits
  classically catch is also caught by wall-clock. Adding CPU would require
  either a heartbeat protocol (approximate, noisy) or a native `setrlimit`
  module (cross-platform pain) for marginal value. If a real use case shows
  up later (e.g., shared-tenant pricing), the natural implementation would
  be `setrlimit` rather than heartbeat polling.
- **Heartbeat / liveness protocol**. Hand-in-hand with CPU above —
  unnecessary in v1 once CPU is dropped. Adding it later for hang detection
  is straightforward; we don't need to build the channel speculatively.
- **Network and filesystem limits**. These require real isolation
  (`isolated-vm`, container, seccomp); see
  [sec-isolation-recs.md](../../sec-isolation-recs.md). Not addressable from
  pure parent-side enforcement.
- **Per-tool budgets** (e.g., "this subprocess can make at most 5 LLM
  calls"). Possibly useful but a different feature; addressable via the
  guards system if/when it lands.
- **Per-stream stdout/stderr limits**. v1 has a single `stdout` parameter
  applied identically to fds 1 and 2. Splitting them is a trivial extension
  if needed.

## Risks and open questions

- **Stdout pipe-through latency**. Switching from `"inherit"` to `"pipe"`
  adds one event-loop tick of latency per stdout chunk. Should be
  imperceptible but worth verifying for tests that depend on real-time
  output ordering.
- **OOM exit code ambiguity**. V8 OOM exits with code 134 on most platforms,
  but Node may report it differently in some environments. The close
  handler should check for both common OOM signatures (exit code, signal,
  stderr containing "out of memory") and conservatively report
  `limit_exceeded` rather than misclassifying genuine crashes.
- **Breaking change visibility**. The flat-API change breaks the in-tree
  test fixtures and any external code that already uses the old `{node,
  args}` shape. PR description must call this out clearly.
