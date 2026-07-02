# Subprocess Pause/Resume — Design

**Date:** 2026-07-01
**Status:** Approved design, pending implementation plan

## Problem

Agency code can compile and run Agency code in a subprocess (`std::agency`'s
`compile()` / `run()`). The parent's handler chain extends across the process
boundary, which is the core safety promise: agent-generated code stays gated
by user-written handlers.

Today that promise has a hole. When a subprocess interrupt is **not** resolved
by any handler (child or parent), the interrupt should surface to the user for
manual confirmation and the subprocess should later resume exactly where it
left off — the same treatment every in-process interrupt gets. Instead, the
MVP **auto-rejects** it (`"subprocess slow-path not yet supported"`,
`lib/runtime/ipc.ts`). Unhandled ≠ surfaced; unhandled = rejected.

Two secondary defects fall out of the same MVP shortcut:

1. **Vote poverty.** The child only reports `{ propagated: boolean }` to the
   parent. A child whose own handler *approved* an interrupt, running under a
   parent with no handlers, gets **rejected** (child approve → consult parent →
   parent noResponse → mapped to reject). Under single-process chain semantics
   that must be an approve.
2. **Ignored propagate votes.** The parent never reads `subprocessVotes`, so a
   child handler that votes `propagate` (explicitly requesting user attention)
   is silently overridden.

Additionally, the concurrent case (child uses `fork`; multiple branches
interrupt at once) works architecturally but is untested, and mixed batches
(some interrupts handled, some not) degrade to per-interrupt auto-rejection.

## Design overview

The mechanism: **"propagate" becomes an outcome the child acts on by pausing
itself using its own, existing checkpoint machinery.** No new state-capture
machinery is invented; the pause/resume that already powers in-process
interrupts runs inside the child, and the parent carries the child's
serialized state as opaque data inside its own checkpoint.

```
Parent process                                Child process
──────────────                                ─────────────
run(compiled)                                 branch hits interrupt
  _run: runBatch, 1 child   ◄── interrupt ──  child runs LOCAL handler chain
  parent runs ITS chain,                      (local reject = final, no consult)
  replies with its OUTCOME  ─── outcome ───►  child MERGES child+parent outcomes
  (approved/rejected/                         verdict = propagate?
   propagated/noResponse)                       → normal-mode propagate path:
                                                  Interrupt[] bubbles through
                                                  child's runBatch (siblings
                                                  settle, shared checkpoint)
  _run stores opaque payload ◄─ interrupted ─  bootstrap sends interrupts +
  {childCheckpoint, ids,        (terminal)     checkpoint, exits 0
   node}, stamps parent
  checkpoint via runBatch,
  returns Interrupt[] to user

user → respondToInterrupts(interrupts, responses)
  parent replays → _run finds payload +
  responses → forks fresh child      ─── resume ───►  bootstrap restores
                                                      checkpoint + responses,
                                                      re-runs node; replay
                                                      short-circuits completed
                                                      branches, re-enters
                                                      interrupted ones
```

Rejected alternative — *parent-requested serialization of a blocked child*: a
branch parked inside `sendInterruptToParent` is mid-`await`, which is not a
checkpointable state. Serializing requires unwinding through the interrupt-
return path anyway, which is this design with an extra round-trip. A second
rejected alternative — *keep the child alive while the user thinks* — fails
the durability requirement (parent checkpoints must be resumable after the
parent process exits) and fights the replay-from-checkpoint resume model.

## The distributed handler chain contract

There is **one logical handler chain spanning both processes**: child handlers
are the inner segment, parent handlers the outer segment, exactly as if the
child's code were inlined inside the parent's `handle` blocks.

**The child renders the verdict.** The parent is not an authority; it is a
chain segment that reports its outcome. Per-interrupt flow:

1. Child runs its local chain. Local **reject → final**, fail-fast; the parent
   is never consulted (matches single-process short-circuit, and a parent
   handler cannot un-reject in a single process either).
2. Otherwise the child sends the interrupt to the parent. The parent runs its
   chain and replies with its **chain outcome** — the existing
   `HandlerChainOutcome` type, serialized:
   `rejected(value) | approved(value) | propagated | noResponse`.
   (When the parent is itself a subprocess — see Nested subprocesses — it
   replies with the *merge* of its local chain and its own parent's outcome:
   the `gatherChainOutcome()` helper recurses.)
3. The child ORs the parent's flags into its local flags and falls through to
   its **existing normal-mode decision tail** (`interruptWithHandlers`,
   `lib/runtime/interrupts.ts`): any reject → reject; any propagate →
   propagate; any approve → approve; total silence → propagate.

Combined outcomes (child chain × parent chain):

| Child chain | Parent chain | Combined outcome |
|---|---|---|
| reject      | (never consulted) | reject |
| any         | reject       | reject |
| propagate   | approve / noResponse | **propagate to user** |
| any         | propagate    | **propagate to user** |
| approve     | noResponse   | **approve** (fixes today's wrongful reject) |
| noResponse  | approve      | approve |
| noResponse  | noResponse   | **propagate to user** (fixes today's wrongful reject) |

**Approved values:** outermost approver wins, matching single-process chain
walking. Parent handlers are the outer segment, so a parent approved-value
beats the child's — the existing `parentDecision.value ?? approvedValue`
fallback is kept.

**Why child-side combining is safe:** enforcement always happens in the
child's runtime regardless of where the arithmetic runs — even a parent
"verdict" is just a message the child's trusted TypeScript runtime acts on.
The agent authors only Agency source; the chain logic it flows through is core
library code in both models. (Orthogonal caveat, unchanged by this choice:
`compile()` permits `pkg::` npm imports, so a child could run arbitrary JS
that subverts its own runtime. That defeats parent-authoritative combining
equally. The trust boundary is the process; hardening it means sandboxing,
out of scope.)

**Why child-side combining is better:** the combination logic exists in
exactly one place — the child's existing normal-mode tail — instead of being
duplicated in the parent's `handleInterruptMessage`. And the propagate case is
not a special IPC feature; it is the child's ordinary propagate path
executing, which is precisely what makes the checkpoint machinery fire.

**Liveness rule:** the parent always sends an explicit outcome message. The
child never infers anything from silence (a silent parent would park the child
until the wall-clock limit kills it).

## IPC protocol changes

- **Decision message** (parent → child, per interrupt): replaces
  `{ approved: boolean, value }` with the parent's serialized chain outcome:
  `{ type: "decision", interruptId, outcome: "approved" | "rejected" | "propagated" | "noResponse", value? }`.
- **`SubprocessVotes` is deleted.** The parent no longer needs the child's
  votes for anything; the child combines.
- **New terminal message** (child → parent):
  `{ type: "interrupted", interrupts: SerializedInterrupt[], checkpoint: CheckpointJSON, subprocessSessionId }`
  — a third terminal outcome alongside `result` and `error`. Counts against
  the `ipcPayload` limit like every message; over the limit → the existing
  structured limit failure (the run **fails loudly rather than pausing
  un-resumably**).
- **New startup instruction** (parent → child):
  `{ type: "resume", scriptPath, node, checkpoint, responses: Record<interruptId, response>, runId, spanContext, subprocessSessionId }`
  — the resume-mode sibling of `{ type: "run" }` (which also gains
  `runId` / `spanContext` / `subprocessSessionId`; see Statelog).
- The message set stays a discriminated union that is trivially extensible —
  deliberate, because the follow-ups (cost telemetry, callback forwarding)
  will add message types.

## `CompiledProgram` carries the code

Today `compile()` writes transpiled JS to `.agency-tmp/<nanoid>/<moduleId>.js`
as a side effect and returns `{ path, moduleId }` — a file reference. That
makes any checkpoint containing a `compiled` value a dangling pointer: resume
after cleanup, in a new process, or on another machine, and the path is dead.
The child's code is *generated at runtime*, so unlike static modules it cannot
be assumed present at resume time — it must travel with the state.

Change: **`CompiledProgram` becomes `{ moduleId, code }`** (compiled JS text).
`compile()` stops writing to disk. `_run` materializes the file into
`.agency-tmp/` at every fork — initial and resume — and deletes it on every
settle, including the interrupted settle. Consequences:

- The parent checkpoint is **fully self-contained**: the code rides in the
  `compiled` variable (an ordinary serialized value in the parent's frame
  state, replayed like any other argument), the child's execution state rides
  in the opaque payload. Nothing references disk.
- The temp-dir retention problem evaporates: no keep-alive-while-paused, no
  orphan-GC policy for paused runs. Materialize per fork, delete per settle.
- `run("path/to/file.agency")` (run-a-file variant): the source is on disk by
  definition; `_run` compiles it and the in-memory `CompiledProgram` behaves
  identically from that point on.

## Child-side pause path

When the merged verdict is propagate, `interruptWithHandlers` in IPC mode
returns `[interrupt(...)]` via the **existing normal-mode propagate branch**.
From that point the child behaves exactly like an in-process program:

- The interrupt bubbles through the child's own `runBatch` sites. Concurrent
  siblings settle first — approved branches run to completion and cache
  results via `setResultOnBranch`; other propagated siblings batch in. One
  shared child checkpoint is stamped; `runNode` returns `Interrupt[]`.
- The bootstrap (`lib/runtime/subprocess-bootstrap.ts`) gains one check: if
  the node result is an interrupt batch, serialize and send `interrupted`
  instead of `result`, then exit 0. **The child process is gone while the user
  thinks** — no resources held, no live-process bookkeeping.

Invariants stated here because they are load-bearing:

- Child-local reject remains final and never consults the parent.
- The interrupt IDs in the `interrupted` message are the child's own IDs — the
  same ones saved in the child checkpoint's frame locals (`__interruptId_N`) —
  because they are the keys the entire resume routes on.

## Parent-side: `_run` becomes a runBatch adopter

`_run` (`lib/runtime/ipc.ts`) restructures from a hand-rolled promise into the
fourth `runBatch` adopter (after fork, race, and the runPrompt tool loop) —
per `docs/dev/concurrent-interrupts.md`: any new layer that wraps
sub-execution and stamps checkpoints must use `runBatch`, not hand-roll.

- **Mode `"all"`, a single child.** Branch key: a constant (`subprocess_0`) —
  one child per `_run` call site, trivially stable across resume.
- **`parentStack`**: the local slice from `getRuntimeContext()` — this is what
  makes the slice rule hold automatically when `run()` sits inside a fork
  branch.
- **The child's `invoke`**: materialize code, fork bootstrap, send `run` or
  `resume`, await the terminal message. Outcome mapping (honoring the
  return-never-throw-`Interrupt[]` contract):
  - `result` → return the value (`{ data, tokens, messages }`, unchanged).
  - `interrupted` → write the opaque payload, then **return** the rehydrated
    `Interrupt[]`.
  - `error` / crash / limit → throw or return failure exactly as today
    (errors-win-over-interrupts invariant is inherited).
- **Rehydration**: child interrupts arrive as JSON. Parent constructs
  `Interrupt` objects preserving `interruptId` verbatim and discarding any
  child-side per-interrupt checkpoint field — `runBatch`'s parent-side stamp
  replaces it. The batch-level child checkpoint goes into the opaque payload,
  never onto the interrupt objects.
- **The opaque payload**:
  `{ childCheckpoint, pendingInterruptIds, node, subprocessSessionId }`,
  written to a reserved frame local (`__subprocess_state_0`-style — the same
  mechanism as `__interruptId_N` / `__race_winner_<id>`). Plan-time call:
  frame local vs. a new serialized `BranchState` field. The binding
  constraints either way: serializes with parent state; scoped to this call
  site; **never walked by `State.toJSON`'s branches composition** — the child
  checkpoint's frames belong to a different process and module and must never
  be spliced into the parent's replay.
- **What runBatch provides for free**: shared parent checkpoint stamped at the
  `_run` location; `.checkpoint` overwritten on every surfaced interrupt;
  branch interrupt-state recording; multi-cycle re-entry dispatch;
  cached-result short-circuit; abort-signal composition.
- **Abort → kill**: `_run`'s invoke listens on the composed branch
  `AbortSignal` and kills the child on abort. This closes the deferred
  "parent cancellation / time-guard → child teardown" MVP gap.
- Interrupts bubble out of the stdlib `run()`'s `return try _run(...)` like
  any function-call interrupts (`try` catches failures only) and compose
  upward, batching with parent-side siblings when inside a fork.

## End-to-end resume

Worked example: parent called `run()`; the child forked two branches; branch
1's interrupt was approved by a parent handler; branch 2's got `noResponse`
everywhere.

**Pause.** Branch 2's merged verdict is propagate → normal-mode tail returns
`[intr]` → the child's fork-level `runBatch` waits for branch 1 to finish
(result cached), stamps the shared child checkpoint, returns the batch →
`runNode` returns `Interrupt[]` → bootstrap sends `interrupted`, exits →
parent `_run` stores the payload, returns rehydrated interrupts → parent
`runBatch` stamps the parent checkpoint → interrupts surface to the user.
Two processes' worth of paused state; one serializable `Interrupt[]`.

**Resume.** `respondToInterrupts(interrupts, responses)` → standard parent
restore (fresh execCtx **reusing the original runId** per existing convention,
`restoreState`, response map, replay). Replay re-registers parent handlers
(`pushHandler` re-executes — handlers are never serialized), reaches the
`_run` step; `runBatch` re-enters the interrupted branch; `_run`'s invoke
finds the payload, sees a response for every `pendingInterruptIds` entry via
`ctx.getInterruptResponse(id)`, and sends `resume` instead of `run`. The
bootstrap calls a **new runtime resume entry** — a sibling of
`respondToInterrupts` that takes an explicit checkpoint + response map +
node — restoring the child's state tree. Child replay skips branch 1 (cached
result), re-enters branch 2; the interrupt site finds its saved
`__interruptId_N`, reads the response, continues.

Design the resume entry as a clean public seam, not a bootstrap-private
helper — it is exactly the primitive a future `agency resume <file>
<checkpoint.json>` CLI command needs (see Follow-ups).

**Terminal outcomes of a resumed segment:** `result` → `_run` clears the
payload and returns the value. `interrupted` again → same pause flow, payload
overwritten, multi-cycle indefinitely. A **rejection response is not an
abort**: the child's interrupt site returns the rejection into the child's
code as a normal failure result; the child may continue and complete.

**Handler re-registration is a hard invariant** (handlers are safety
infrastructure): child replay re-registers the child's own handlers before any
interrupt site resolves, and new interrupts in a resumed child that *are*
handler-covered take the ordinary per-interrupt round-trip — the parent's
replaying execCtx has its handlers back before the `_run` step replays,
because registration replays first. Dedicated tests below.

## Concurrent-interrupt semantics

This design makes the subprocess story **converge** with the in-process one:

- **All handled** (fast path, unchanged): N child branches make N independent,
  concurrent IPC round-trips; each resolves in place; nothing pauses. Routing
  is ID-keyed on both sides (`sendInterruptToParent` filters decisions by
  message ID). Previously untested — tests added.
- **Mixed**: handled branches resolve and run to completion; propagated
  branches batch through the child's `runBatch`. The `interrupted` message
  carries only genuinely-unresolved interrupts; completed siblings' results
  are already cached inside the child checkpoint and short-circuit on resume.
- **None handled**: all branches batch; one child checkpoint; one
  `interrupted` message; the user answers the whole array with a single
  `respondToInterrupts`, same as in-process concurrent interrupts.

**Multiple concurrent subprocesses** (parent `fork` with a `run()` per
branch) compose by nesting, with no new mechanism:

- Each branch's `_run` is a runBatch site nested inside the fork-level
  runBatch branch. Each stores its own payload in its own branch slice and
  returns its child's interrupts.
- The fork-level runBatch batches interrupts from all branches, stamps **one**
  shared fork-level checkpoint (whose `branches` map contains each slice, each
  containing that branch's payload), and overwrites `.checkpoint` on every
  interrupt.
- The user sees one flat `Interrupt[]` — child A's, child B's, and any
  pure-parent interrupts, indistinguishable in shape — answered with one call.
- On resume, each `_run` claims only the response IDs recorded in its own
  payload; children re-fork and resume concurrently and independently.
  Interrupt IDs are nanoids — globally unique across processes for all
  practical purposes.

Because paused children have exited, "three paused subprocesses" is just three
JSON blobs in three branch slices of one parent checkpoint.

## Nested subprocesses: unblocked

The hard block (`isIpcMode()` throw in `_run`) existed because the MVP had no
good answer to runaway agent-writes-agent recursion — auto-reject made the
`std::run` gate toothless, so nesting was forbidden outright. This design
replaces the hard block with the language's own idiom plus a backstop.

**Safety model.** Every `run()` already throws `interrupt std::run(...)`
before executing. With pause/resume in place, an unhandled `std::run`
interrupt from *any* depth flows through the distributed handler chain and
**surfaces to the user** — the default for un-gated nesting becomes "pause and
ask the human," strictly better than both auto-reject and a hard error. Users
who want nesting blocked write one handler at the top that rejects
`std::run`; users who want it bounded reject based on the depth carried in
the interrupt data (below).

**Depth tracking.**

- `RuntimeContext` gains a `subprocessDepth` field: 0 in the root process,
  seeded in each child from the `run`/`resume` instruction (propagated as
  parent depth + 1 at fork).
- The `std::run` gate interrupt's `data` includes `depth` — the depth the
  prospective child would run at (`ctx.subprocessDepth + 1`) — so handlers,
  Agency or TS, can reject by depth.
- TS helpers: the field is readable via `agency.ctx().subprocessDepth`
  (`docs/site/appendix/ts-helpers.md` surface); a lax convenience accessor is
  a plan-time nicety.
- **Depth cap backstop**: a handler that blindly approves everything would
  still permit infinite recursion, so `_run` enforces a configurable
  `maxDepth` (proposed default 5, clamped by a hardcoded ceiling per the
  `LIMIT_CEILINGS` pattern). Violation → the structured limit-style failure
  (`limit: "depth"`), converting "runaway process tree" into a clean error
  regardless of handler behavior.

**Mechanics: nesting composes recursively with zero new machinery.** Take
P0 → P1 → P2:

- *Per-interrupt consultation recurses through existing code.* When P2
  interrupts, P1's `_run` gathers P1's chain outcome — and because P1 is
  itself in IPC mode, gathering automatically consults P0. P0 replies with
  its outcome; P1 replies the merge of (P1 local + P0) to P2; P2 renders the
  verdict. The refactor this wants — shared by the flat case — is a
  `gatherChainOutcome()` helper returning the merged `HandlerChainOutcome`
  (local chain, plus recursively the parent's when in IPC mode), used both to
  reply to a child and to feed one's own verdict. Reject stays fail-fast at
  every level (a P1-local reject replies rejected without consulting P0).
- *Pause is Russian dolls all the way down.* P2 checkpoints, sends
  `interrupted`, exits → P1's `_run` stores P2's checkpoint as its opaque
  payload and returns the `Interrupt[]` → they bubble up P1's stack → P1's own
  bootstrap sends `interrupted` to P0 with P1's checkpoint (containing P2's,
  nested) → P0 surfaces to the user. Every process in the tree has exited; the
  paused tree is one self-contained JSON blob.
- *Resume unwinds the dolls.* P0 replays → re-forks P1 with `resume` → P1
  replays → re-forks P2 with `resume` → P2 continues. No level knows how deep
  the tree goes.

**Nesting-specific plan items** (real but not architectural):

- **Lock relay to the root**: today `_run` grants a child's `lockAcquire` via
  `acquireLocalLock` on its own ctx. Nested, a mid-tree process must relay
  lock requests upward so the whole tree shares one lock domain.
- **Limit interactions, documented**: P2's stdout forwards through P1 and
  counts against P1's stdout budget at P0; P1's wall-clock ticks while P2
  runs; `interrupted` payloads compound (checkpoint-in-checkpoint), all under
  each hop's `ipcPayload` limit.
- **Statelog**: depth composes — P2 inherits the root runId through P1;
  `subprocessRun` spans nest.

**Sequencing**: land the flat case first; nesting is the **last increment**
of the implementation plan (guard removal + depth plumbing + lock relay +
tests) once the flat machinery has stabilized.

## Statelog and runId

- The child **inherits the parent's runId**; it does not mint its own. This
  matches the existing convention that a runId persists across interrupt
  pauses/resumes (`lib/runtime/interrupts.ts` — resume contexts are created
  with the original `interrupt.runId`).
- Each child segment is wrapped in a **new statelog span/node type**
  (`subprocessRun`), so child events nest under the parent run in their own
  section instead of appearing as a disconnected run.
- A stable **subprocessSessionId** (minted at first fork, carried in the
  opaque payload and in `run`/`resume` instructions) tags every segment of the
  same logical child run — multi-cycle segments correlate; concurrent
  subprocesses stay distinct within one parent runId.
- Q1 hardening: the parent wraps concurrent `handleInterruptMessage` handler
  chains in branch-context span isolation (`runInBranchContext`-style) so
  concurrent chains stop interleaving spans on the parent's stack.

## Lifecycle, limits, accounting

- **Temp files**: materialize from `CompiledProgram.code` at every fork;
  delete on every settle including interrupted. Existing path-safety checks
  (`cleanupTempDir` strict-descendant rule) unchanged.
- **Wall-clock / memory / stdout: per-segment.** Each forked process gets a
  fresh budget; timers cleared at segment settle. These limits guard runaway
  *processes*, not end-to-end latency — user thinking time cannot count
  against a process that no longer exists. Accepted, documented quirk: a
  child that pauses N times gets N stdout budgets. If that ever matters,
  cumulative counters can ride in the opaque payload (follow-up, not v1).
- **ipcPayload**: applies to the `interrupted` message (dominant term: the
  child checkpoint). Violation → structured limit failure; fail loudly, never
  pause un-resumably.
- **Tokens**: child token stats live in its per-execution GlobalStore, which
  serializes inside the child checkpoint — they flow across segments
  automatically and the final `result.tokens` is cumulative. (Verify during
  implementation; it is the token-stats-in-GlobalStore pattern.)
- **Locks**: child-held parent-brokered locks release at segment settle
  (existing `cleanupSessionLocks`); lock-acquisition steps are completed steps
  that replay skips. Net: **locks do not survive a pause** — already the
  in-process checkpoint semantic (releasers are not serialized there either).
  Documented consistency, not new behavior.

## Invariants

1. One logical handler chain spans both processes; the child renders the
   verdict from combined outcome flags using the existing normal-mode tail.
2. The parent always replies with an explicit outcome; the child never infers
   from silence.
3. Child-local reject is final and never consults the parent.
4. Child interrupt IDs are preserved verbatim end-to-end; they are the resume
   routing keys.
5. The child checkpoint is opaque data in the parent; it is never spliced into
   the parent's state-tree composition or replay.
6. The parent checkpoint is fully self-contained: compiled code travels in
   `CompiledProgram.code`; child state travels in the opaque payload.
7. `_run`'s invoke returns `Interrupt[]`, never throws it (runBatch contract);
   errors win over interrupts.
8. Handler re-registration during replay — parent and child — completes before
   any interrupt site resolves. Handlers are safety infrastructure; any risk
   of a skipped handler is a critical bug.
9. A paused subprocess holds no live resources: process exited, temp files
   deleted, locks released, timers cleared. Nested: the whole paused tree has
   exited.
10. Subprocess depth is tracked on `RuntimeContext`, propagated at fork,
    carried in every `std::run` gate interrupt's data, and capped by `_run`
    regardless of handler behavior.

## Testing

Agency execution tests in `tests/agency/subprocess/` unless noted; agency-js
where `respondToInterrupts` must be driven from JS. The four-cycle discipline
from `docs/dev/concurrent-interrupts.md`, applied across the process boundary:

1. **Q1 concurrency, no pause**: fork in child, all interrupts parent-handled;
   N concurrent round-trips resolve correctly.
2. **Single pause/resume** (agency-js): unhandled child interrupt surfaces;
   approve; child resumes and completes.
3. **All-unhandled batch**: fork in child, nothing handled → one flat
   `Interrupt[]`; one respond resumes all branches.
4. **Mixed batch**: approved siblings complete and cache; only unhandled
   surface; resume short-circuits cached branches (assert no re-execution via
   side-effect counter).
5. **Multi-cycle**: resumed child interrupts again; second respond completes.
6. **Vote-combining matrix**: child-approve + parent-silent → approve (the
   regression fix); child-propagate + parent-approve → surfaces;
   parent-reject → reject; all-silent → surfaces.
7. **Handler re-registration post-resume** (critical safety test): resumed
   child's second interrupt is caught by its child-local handler.
8. **Concurrent subprocesses**: parent fork with two `run()` calls, both
   pause → one batch; both resume independently.
9. **Durability** (agency-js): serialize the `Interrupt[]` to disk, wipe
   `.agency-tmp`, respond from a fresh process — proves self-containment (the
   `CompiledProgram.code` payoff).
10. **Rejection response**: user rejects a surfaced child interrupt; child
    resumes, receives the failure result, continues, completes.
11. **Limits**: oversized `interrupted` message → structured limit failure;
    wall-clock budget resets per segment.
12. **Existing-test audit**: tests asserting the old `"slow-path not yet
    supported"` rejection flip to expecting surfaced interrupts;
    `handler-approve` / `handler-reject` / `run-multiple-interrupts` pass
    unchanged; `nested-blocked` flips to the new semantics (gate interrupt +
    depth cap instead of an immediate error); `runBatch`-adopter unit tests
    in `ipc.test.ts`.
13. **Nesting** (last increment): 3-level pause/resume through the full tree;
    reject at the middle level (fail-fast, root never consulted); depth value
    visible in `std::run` interrupt data and via `agency.ctx()`; depth-cap
    violation → structured failure; nested multi-cycle.

Implementation must also update `docs/dev/subprocess-ipc.md` (the MVP
limitations it documents are precisely what this design removes).

## Out of scope / follow-ups

- **`agency resume` CLI command**: resume any agency file from a saved
  checkpoint + responses file. This design builds the primitive (the explicit
  checkpoint + response-map resume entry); the CLI is a thin wrapper.
- **Cost/time guards across subprocesses**: the abort half lands here (parent
  abort → child kill via composed signals). The missing half is incremental
  cost telemetry — a `{ type: "telemetry", tokens, usd }` message per LLM call
  or periodic — folded into parent cost-guard accounting; a tripped guard
  aborts → kills. The protocol's discriminated union is kept extensible for
  this.
- **Callback forwarding**: parent-registered lifecycle callbacks
  (`onToolCallStart`, …) triggered by subprocess events, forwarded over IPC.
  Open question for that design: fire-and-forget vs. blocking round-trips
  (in-process `callHook` is sequential and awaited, so likely blocking, with
  the same no-parked-child liveness discipline).
- **Cumulative resource limits across segments** (counters in the opaque
  payload) if per-segment budgets prove gameable in practice.
- **Sandboxing** of child processes (the `pkg::` arbitrary-JS trust caveat) —
  orthogonal to decision-authority placement.
