# Subprocess IPC — How agents run agents

## Overview

Agency agents can compile and execute Agency code at runtime in a subprocess. The parent process's handler chain extends across the process boundary — a parent handler that rejects file deletions will reject them in the subprocess too, even if the subprocess has its own handler that approves. When NO handler resolves an interrupt, the subprocess **pauses itself**: it checkpoints its state, exits, and its interrupts surface to the user exactly like in-process interrupts; `respondToInterrupts` resumes it in a fresh process from exactly where it left off.

The user-facing API is two functions in `std::agency`:
- `compile(source)` — compile Agency source code, returns a `Result<CompiledProgram>`
- `run(compiled, { node, args })` — execute a compiled program in a subprocess, returns a `Result`

## Architecture

```
Parent process                          Child process
┌──────────────────────┐               ┌───────────────────────────┐
│ Agency code calls    │               │ subprocess-bootstrap       │
│ run(compiled, opts)  │               │ receives run/resume msg    │
│         │            │    fork()     │ imports compiled .js       │
│  _run (runBatch      ├──────────────►│ calls node fn / resumes    │
│   adopter, 1 child)  │               │           │                │
│         │◄───────────┼─ interrupt ───┤ interruptWithHandlers:     │
│  gatherChainOutcome  │               │  local chain, then consult │
│  (parent's chain)    │               │  parent, MERGE, decide     │
│         ├────────────┼─ outcome ────►│           │                │
│         │            │               │ approve/reject → continue  │
│         │            │               │ propagate → CHECKPOINT     │
│         │◄───────────┼─ interrupted ─┤  + exit (pause)            │
│  save opaque payload │               │                            │
│  surface Interrupt[] │               │ …or on completion:         │
│         │◄───────────┼─ result ──────┤ sends result, exits        │
└──────────────────────┘               └───────────────────────────┘

user → respondToInterrupts(interrupts, responses)
  parent replays → _run finds payload + responses → forks fresh child
  with a resume instruction → child restores checkpoint and continues
```

Communication uses Node's built-in IPC channel (`child_process.fork()`). Stdout/stderr flow through normally for `print()` output.

## Key files

| File | Role |
|------|------|
| `lib/runtime/ipc.ts` | IPC types, `sendInterruptToParent()`, `_run()` (runBatch adopter), `runSubprocessSession()`, resume payload accessors, debug logger |
| `lib/runtime/subprocess-bootstrap.ts` | Entry point forked by `_run()`. Handles `run` and `resume` instructions, sends `result`/`interrupted`/`error` back. |
| `lib/runtime/interrupts.ts` | `interruptWithHandlers()` (child-side merge + verdict), `gatherChainOutcome()` (parent-side reporting; recurses when nested), `mergeChainOutcomes()` |
| `lib/runtime/subprocessRunInfo.ts` | Per-process identity seeded by the bootstrap: inherited runId, session id, parent span id |
| `lib/stdlib/agency.ts` | `_compile()` — runs the compilation pipeline, returns `{ moduleId, code }` |
| `stdlib/agency.agency` | User-facing `compile()` and `run()` functions |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | `_run` AgencyFunction wrapping |

## The distributed handler chain

There is ONE logical handler chain spanning both processes: child handlers are the inner segment, parent handlers the outer segment. **The parent reports; the child decides.**

1. The child runs its local chain. A local **reject is final** — fail-fast, the parent is never consulted (a parent cannot un-reject in a single process either).
2. Otherwise the child sends the interrupt to the parent (`{ type: "interrupt" }`, message id = the child's interrupt-level id, preserved verbatim). The parent runs its own chain via `gatherChainOutcome()` and replies with its **chain outcome** — `HandlerChainOutcome`: `rejected(value) | approved(value) | propagated | noResponse` — never a verdict.
3. The child merges (`mergeChainOutcomes`, single-process precedence: reject > propagate > approve > noResponse; on double-approve the outer value wins) and renders the verdict locally.

| Child chain | Parent chain | Combined outcome |
|---|---|---|
| reject      | (never consulted) | reject |
| any         | reject       | reject |
| propagate   | approve / noResponse | propagate to user |
| any         | propagate    | propagate to user |
| approve     | noResponse   | approve |
| noResponse  | approve      | approve |
| noResponse  | noResponse   | propagate to user |

The parent ALWAYS replies explicitly; the child never infers from silence. When the parent process is itself a subprocess, `gatherChainOutcome` recurses upward and replies with the merged outcome of everything above — this is what makes nesting compose.

## Pause and resume

When the merged verdict is propagate (or total silence), `interruptWithHandlers` returns `Interrupt[]` through the child's **normal propagate path**: the interrupt bubbles through the child's own `runBatch` sites (concurrent siblings settle first — approved branches complete and cache results, other propagated siblings batch in), one shared child checkpoint is stamped, and `runNode` returns the batch. The bootstrap converts it into a terminal message:

```
{ type: "interrupted", interrupts: SerializedInterrupt[], checkpoint, subprocessSessionId }
```

and exits 0. **The child process is gone while the user thinks** — no live resources, no locks (released at settle), no timers.

On the parent side, `_run` — a `runBatch` adopter with a single child (`subprocess_0`) — stores an opaque resume payload in a frame local (`saveSubprocessPayload`): `{ childCheckpoint, interrupts, node, subprocessSessionId }`. The child checkpoint is OPAQUE — its frames belong to another process and are never spliced into the parent's `State.toJSON` composition or replay. `_run` then returns the rehydrated interrupts (checkpoints stripped); `runBatch` stamps the parent-side shared checkpoint on them and they bubble to the user, batching with any parent-side siblings if `run()` was inside a fork.

**Resume:** `respondToInterrupts` replays the parent; `_run` re-runs, finds the payload plus a response for every pending interrupt id (`collectSubprocessResponses` — order-preserving, ids are the routing keys), and forks a fresh child with a `resume` instruction. The bootstrap re-attaches the shared checkpoint to each interrupt and calls the compiled module's own `respondToInterrupts` export — the exact machinery in-process resumes use. Replay re-registers handlers on BOTH sides before any interrupt site resolves (handlers are safety infrastructure; covered by `pause-then-child-handler` and `pause-then-parent-handler` tests). A resumed child that pauses again re-enters the same cycle (multi-cycle). A rejection response is not an abort: the interrupt site returns the failure into the child's code, which continues.

**Durability:** the parent checkpoint is fully self-contained. `CompiledProgram` is `{ moduleId, code }` — `compile()` does not touch disk; `_run` materializes the script into `.agency-tmp/<nanoid>/` at every fork and deletes it at every settle. The surfaced `Interrupt[]` survives a JSON round-trip and resumes in a fresh process after wiping `.agency-tmp` (see `tests/agency-js/subprocess-durable-resume`).

## Message protocol

**Subprocess → Parent:**
```typescript
{ type: "interrupt", interruptId, interrupt: { effect, message, data, origin } }
{ type: "result", value: { data, messages, tokens } }
{ type: "interrupted", interrupts: SerializedInterrupt[], checkpoint, subprocessSessionId }
{ type: "error", error: string }
{ type: "lockAcquire" | "lockRelease", ... }
```

**Parent → Subprocess:**
```typescript
{ type: "run", scriptPath, node, args, ipcPayload, configOverrides?, runId, subprocessSessionId, spanContext? }
{ type: "resume", scriptPath, node, checkpoint, interrupts, responses, ipcPayload, configOverrides?, runId, subprocessSessionId, spanContext? }
{ type: "decision", interruptId, outcome: HandlerChainOutcome }
{ type: "lockGranted", ... }
```

`interruptId` on the wire IS the child's interrupt-level id, end-to-end: it keys the decision reply, both processes' statelog events, and the user's resume response.

## Statelog identity

- The child **inherits the parent's runId** (`subprocessRunInfo.ts`, seeded by the bootstrap before the module import; `runNode` uses it instead of minting). One trace spans both processes and all pause/resume segments — matching the in-process convention that runIds persist across resumes.
- The parent wraps each subprocess segment in a `subprocessRun` span and passes its id as `spanContext`; the child's statelog client adopts it as an external root (`adoptExternalParentSpan`), so child spans nest under the parent's span tree.
- `subprocessSessionId` (minted at first fork, echoed through the `interrupted` payload, reused on resume) correlates all segments of one logical child run and distinguishes concurrent subprocesses. It is a protocol/payload-level correlator, not a per-event wire field — statelog-level correlation rides on the shared runId + span nesting.
- Concurrent parent-side handler chains run inside `runInBranchContext` so their `handlerChain` spans don't interleave.

## How compiled code gets executed in the subprocess

1. `_compile()` runs the Agency compilation pipeline and returns `{ moduleId, code }` — no disk writes.
2. `_run()` writes the code to `.agency-tmp/<nanoid>/<moduleId>.js` under `cwd` (so Node resolves `agency-lang/runtime` against the project's `node_modules`), forks `subprocess-bootstrap.js` with `AGENCY_IPC=1`, and sends the `run` (or `resume`) instruction.
3. The bootstrap imports the compiled script, runs the node (or resumes via the module's `respondToInterrupts`), and reports the terminal outcome.
4. `_run()` deletes the temp dir when the session settles — including the interrupted settle; resume re-materializes from `CompiledProgram.code`.

### Import restrictions

`compile()` sets a stdlib-only import policy: relative imports and Node builtins are rejected. This is both a security constraint and a practical one (generated code has no meaningful filesystem location).

## Limits

Wall-clock, memory, ipcPayload, and stdout limits clamp each subprocess (ceilings in `LIMIT_CEILINGS`). All budgets are **per execution segment**: each fork gets a fresh timer/counters, and paused time never counts (the process doesn't exist while paused). Accepted quirk: a child that pauses N times gets N stdout budgets.

The `ipcPayload` limit applies to the `interrupted` message, whose dominant term is the child checkpoint — an oversized pause **fails loudly** with the structured `limit_exceeded` failure rather than pausing un-resumably (`limit-ipc-payload-interrupted` test).

Token stats live in the child's per-execution `GlobalStore` (`__tokenStats`), which serializes inside the checkpoint's `globals` — so they accumulate across pause/resume segments and the final `result.tokens` is cumulative.

Locks brokered through the parent are released at segment settle, and lock-acquisition steps are completed steps that replay skips — **locks do not survive a pause**, which is already the in-process checkpoint semantic (releasers are not serialized there either).

## The `std::run` interrupt gate

`run()` throws a `std::run` interrupt before executing the subprocess. Running agent-generated code is a dangerous operation: the caller must either have a handler that approves `std::run`, or the interrupt propagates to the user for approval — which, with pause/resume, is a real question rather than an auto-reject.

## Debugging

Set `AGENCY_IPC_DEBUG=1` to log every IPC message to stderr:

```
AGENCY_IPC_DEBUG=1 pnpm run agency run myagent.agency
```

```
[ipc:parent] 22:24:16.703 send run node=main script=.agency-tmp/.../compiled.js
[ipc:child]  22:24:16.730 send interrupt effect=std::bash
[ipc:parent] 22:24:16.730 send decision outcome=noResponse
[ipc:child]  22:24:16.750 send interrupted count=1
[ipc:parent] 22:24:16.750 recv interrupted count=1
```

Uses `process.stderr.write()` which is synchronous — no flushing issues.

## Remaining limitations

- **Nested subprocesses**: a subprocess calling `run()` fails with "Nested subprocess execution is not supported" (being removed behind a depth cap — see the pause/resume spec's nesting section).
- **Debugger/trace integration**: the debugger sees `run()` as an opaque step. No stepping into subprocess code.
- **Cost-guard telemetry**: the parent learns child spend only at terminal messages; incremental cost telemetry is a follow-up.
- **Callback forwarding**: parent-registered lifecycle callbacks are not triggered by subprocess events; follow-up.

## Tests

Execution tests live in `tests/agency/subprocess/`; agency-js tests in `tests/agency-js/subprocess-*`.

| Test | What it verifies |
|------|-----------------|
| `compile-only` / `compile-failure` | compile() success/failure |
| `run-basic` / `run-with-args` / `run-file` / `run-cwd` | plumbing |
| `run-multiple-interrupts` | sequential IPC round-trips |
| `run-crash` / `run-abnormal-exit` | error paths |
| `handler-approve` / `handler-reject` | parent chain outcomes |
| `vote-child-approve-parent-silent` | approve + noResponse = approve (regression) |
| `vote-child-reject-parent-approve` | child reject is final |
| `concurrent-handled` | fork-in-child, all handled, concurrent round-trips |
| `pause-fork-all-unhandled` | one batch, one respond resumes all branches |
| `pause-fork-mixed` | cached branch runs exactly once (marker-file proof) |
| `pause-multi-cycle` | resumed child pauses again |
| `pause-reject-response` | rejection resumes, doesn't abort |
| `pause-two-subprocesses` | two paused children batch into one respond |
| `pause-then-child-handler` / `pause-then-parent-handler` | handler re-registration after resume (safety-critical) |
| `pause-limit-wallclock-resets` | per-segment budgets |
| `limit-ipc-payload-interrupted` | oversized pause fails loudly |
| `limit-*` | resource limits |
| `subprocess-no-handler` (js) | std::run gate surfaces without a handler |
| `subprocess-pause-basic` (js) | end-to-end pause → respond → resume |
| `subprocess-durable-resume` (js) | JSON round-trip + fresh-process resume + artifact wipe |
| `subprocess-statelog-runid` (js) | one trace_id across segments == inherited runId |
