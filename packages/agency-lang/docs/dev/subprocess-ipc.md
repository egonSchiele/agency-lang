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
{ type: "telemetry", costUsd }   // fire-and-forget, one per paid call
{ type: "callback", name, data } // fire-and-forget, one per lifecycle event (see Callback forwarding)
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

Wall-clock, memory, ipcPayload, and stdout limits clamp each subprocess (ceilings in `LIMIT_CEILINGS`). All budgets are **per execution segment**: each fork gets a fresh timer/counters, and paused time never counts (the process doesn't exist while paused). This property is pinned by fake-timer unit tests in `ipc.test.ts` (an end-to-end assertion would require segment-time-vs-cap arithmetic, which is unreliable on loaded CI runners). Accepted quirk: a child that pauses N times gets N stdout budgets.

The `ipcPayload` limit applies to the `interrupted` message, whose dominant term is the child checkpoint — an oversized pause **fails loudly** with the structured `limit_exceeded` failure rather than pausing un-resumably (`limit-ipc-payload-interrupted` test).

Token stats live in the child's per-execution `GlobalStore` (`__tokenStats`), which serializes inside the checkpoint's `globals` — so they accumulate across pause/resume segments and the final `result.tokens` is cumulative.

Locks brokered through the parent are released at segment settle, and lock-acquisition steps are completed steps that replay skips — **locks do not survive a pause**, which is already the in-process checkpoint semantic (releasers are not serialized there either).

**Cost guards** meter subprocess spend live: every paid call in a child
fire-and-forgets `{ type: "telemetry", costUsd }` upward (emitted from
`StateStack.billCharge`, the choke point every paid site funnels
through). The parent bills the charge via `billCharge` on the run()
call-site stack — so parent `getCost()` includes child spend — and a trip
kills the child and surfaces the standard cost-limit Failure at the
owning `guard(cost:)` boundary. Relay to the root is automatic in nested
trees (the mid-tier handler's own `chargeGuards` re-emits upward).
Detection latency is at most one paid call, matching in-process CostGuard
semantics. Telemetry is cost-only; tokens arrive terminally via
`result.tokens`. One `getCost()` edge: telemetry arriving after a kill
(abort, wall-clock, stdout, memory — FIFO rules this out on normal
completion) still charges budgets via the shared guard references, but
can be invisible to `getCost()` if the owning fork branch already joined.
Budgets never undercount; `getCost()` may, on abnormal termination only.

## Callback forwarding

A parent's registered lifecycle callbacks fire for events that happen inside a
`std::agency run()` child. Every lifecycle event in a child fire-and-forgets
`{ type: "callback", name, data }` upward, emitted from `invokeCallbacks`
(`hooks.ts`) — the choke point every event funnels through. The wire type and
child-side sender live in the dependency-light leaf `callbackForwarding.ts`
(`hooks.ts` must not import `ipc.ts`, mirroring the `costTelemetry.ts` layering).

- **Serialization.** The child JSON-serializes once up front: function-valued
  fields (e.g. `onAgentStart.cancel`) are stripped, and an unserializable
  (circular / BigInt) payload degrades to a dropped event rather than a throw.
- **Parent side.** `handleCallbackMessage` (synchronous, like
  `handleTelemetryMessage`) validates the name against `VALID_CALLBACK_NAMES`
  (the child is the less-trusted party), drops post-settle events, then
  `void invokeCallbacks(...)` fire-and-forget so a slow/throwing parent callback
  cannot wedge the message pump. It fires inside the parent's captured ALS store
  frame (`RunSession.parentStore`) and walks the parent's full `ctx.stateStack`,
  so an AgencyFunction callback body resolves `__globals()`/`__threads()` and a
  callback registered on an ancestor frame (e.g. a node-level
  `callback("onNodeStart")` above the `run()` call) is found — matching
  in-process firing.
- **Nested relay is automatic.** `invokeCallbacks` re-emits when THIS process is
  itself a subprocess, so a grandchild's event relays to the root through a
  callbackless mid-tier with no explicit relay code (same shape as cost telemetry).
- **`onAgentStart.cancel` is reconstructed** parent-side to a REAL cancel: a
  parent `onAgentStart` callback that calls `cancel()` kills the child and settles
  `run()` as cancelled. This is best-effort and async (the child already started;
  it is a kill, not the in-process synchronous prevent-start), and a no-op if the
  child's result wins the race.
- **Observational, never fatal.** Forwarding is purely observational: an oversize
  or unserializable `callback` message is dropped, not settled (the
  `isObservationalMessage` carve-out in `handleChildMessage`), preserving the
  invariant that a forwarded event can never kill the run.
- **Unconditional + heavy.** The child cannot know which callbacks the parent
  registered, so every event (except the denylist below) is serialized and sent
  on every occurrence, even with no parent callback — an accepted v1 tradeoff.
- **Not forwarded:** `onStream` (dispatched outside `invokeCallbacks`; forwarding
  it is tracked in #418) and `onOAuthRequired` (carries a `Promise`/functions
  needing a live bidirectional channel) are denylisted in `sendCallbackToParent`;
  `onTrace` is never dispatched today so it simply never forwards.
- **Child-side diagnostics** (`callback_send_failed`, `callback_dropped_oversize`,
  `callback_unserializable`) go to a statelog `debug` event (best-effort, via
  `ipcChildDebug`) plus stderr under `AGENCY_IPC_DEBUG=1`.

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

## Nested subprocesses

A subprocess may itself call `run()`. Safety is the language's own idiom plus a backstop:

- Every `run()` at every level throws its `std::run` gate interrupt through the distributed chain (data includes `depth`, the prospective child depth via `_subprocessDepth() + 1`) — un-gated nesting pauses and asks the user.
- `maxDepth` (default `DEFAULT_MAX_SUBPROCESS_DEPTH = 5`, hard ceiling `SUBPROCESS_DEPTH_CEILING = 10`) backstops blindly-approving handlers with a structured `limit_exceeded`/`depth` failure. The tightest ancestor cap always wins (`resolveDepthCap`; the cap rides the run/resume instruction).
- Everything composes recursively with no new machinery: per-interrupt consultation recurses because a mid-tree `gatherChainOutcome` is itself in IPC mode; a mid-tree reject is fail-fast (the root is never consulted); pause is checkpoint-in-checkpoint Russian dolls and one respond resumes the whole tree; lock requests relay hop-by-hop to the ROOT's lock domain (`handleLockAcquireMessage`); depth is on `RuntimeContext.subprocessDepth` (TS: `agency.ctx().subprocessDepth`).

## Remaining limitations

- **Debugger/trace integration**: the debugger sees `run()` as an opaque step. No stepping into subprocess code.

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
| `limit-ipc-payload-interrupted` | oversized pause fails loudly |
| `limit-*` | resource limits |
| `nested-basic` | 3-level nesting; per-level depth in gate data |
| `nested-depth-boundary` | at-cap allowed, above-cap structured failure; ancestor caps win |
| `nested-pause-resume` | grandchild interrupt surfaces through both hops; one respond resumes the tree |
| `nested-reject-middle` | mid-tree reject is final |
| `nested-lock-relay` | grandchild locks contend with the root's lock domain (marker-file handshake — no duration-based coordination) |
| `cost-guard-trips-on-child-spend` | parent guard trips on child telemetry; child killed; standard Failure |
| `cost-child-spend-in-getcost` | parent getCost() reflects child spend live |
| `cost-nested-relay-trips-root` | grandchild spend relays through a guardless mid-tier to the root guard |
| `cost-two-children-share-budget` | two concurrent children share ONE budget (the ship-guards-into-child counterexample) |
| `cost-no-double-charge-across-pause` | pause/resume replay does not re-emit completed calls' telemetry |
| `callback-forwarding-child-events` | parent onNodeStart callback fires for a child subprocess node entry |
| `callback-forwarding-nested-relay` | root callback fires for a grandchild event relayed through a callbackless mid-tier |
| `callback-forwarding-relay-both-fire` | mid-tier's own callback AND the root's both fire for the same grandchild event, filters respected |
| `nested-gate-unapproved` | the gate exists on every hop |
| `subprocess-no-handler` (js) | std::run gate surfaces without a handler |
| `subprocess-pause-basic` (js) | end-to-end pause → respond → resume |
| `subprocess-durable-resume` (js) | JSON round-trip + fresh-process resume + artifact wipe |
| `subprocess-statelog-runid` (js) | one trace_id across segments == inherited runId |
