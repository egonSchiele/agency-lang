# Review — Checkpoint-as-Soft-Interrupt Implementation Plan

Reviewer pass over `docs/superpowers/plans/2026-07-05-checkpoint-soft-interrupt.md`.
Every claim below was checked against the current runtime source (file:line cited),
not just the plan's internal consistency.

## Verdict

The plan is unusually rigorous and the core design is **sound**: park at the
`runBatch` barrier, stamp one shared checkpoint at the outermost batch, unwind as
a `std::checkpoint` marker in mixed rounds via the *existing* interrupt machinery.
The load-bearing assumptions I could verify hold up (see "Confirmed"). There is
**one correctness issue that must be resolved before Task 1** (nodeId/stack
mismatch), a few medium gaps, and some polish notes. None invalidate the
architecture.

---

## Confirmed correct (the risky claims that actually check out)

- **Detection mechanism (D1) is even more robust than the plan argues.** The
  coordinator lives on the `StateStack` *object*, and `runInBranchAlsFrame` seeds
  `agencyStore.run({ stack: branch.stack, ... })` (`runBatch.ts:362`). Because
  function/block calls inside a branch push frames onto the *same* `StateStack`,
  `getRuntimeContext().stack.batchCoordinator` resolves correctly regardless of
  whether `Runner.runInScope` spreads the outer frame. D1's rejected-alternative
  worry about frame-spreading doesn't even apply to the chosen design — worth
  stating as a strength, since it de-risks the whole approach.
- **Zero-codegen claim (D3) holds.** The generated `hasInterrupts(...)` →
  `runner.halt(...)` → `return` guard is the *generic* post-`__call` pattern
  (`tests/typescriptGenerator/checkpoint-restore.mjs:194-207`), not
  checkpoint-specific. A `checkpoint()` that returns `Interrupt[]` is caught with
  no template change.
- **Serialization safety (D1/D8).** `StateStack.toJSON()`
  (`state/stateStack.ts:727-767`) enumerates fields explicitly; `abortSignal` /
  `interrupted` are live-only and omitted. A new `batchCoordinator?` field is
  silently non-serialized, as claimed.
- **D5's un-restorable-slice argument is valid.** `restoreState`
  (`state/context.ts:617`) does `this.stateStack = StateStack.fromJSON(...)` —
  a wholesale replacement, so a slice-only checkpoint would indeed resume with
  garbage frames. The "only the outermost stamps" rule is justified.
- **API surface exists as assumed:** `ctx.getRunId()` (`context.ts:271`, note it
  *throws* if unset), `ctx.getInterruptResponse(id)` (`context.ts:130`),
  `interrupt({effect,message,data,origin,runId})` returning an `Interrupt` with
  mutable `checkpointId`/`checkpoint` slots (`interrupts.ts:64-87`),
  `setInterruptOnBranch` / `setResultOnBranch` signatures (`stateStack.ts:170-187`),
  race loser-abort with `AgencyCancelledError` + `makeAbortCause({kind:"raceLoser"})`
  (`runBatch.ts:595,610`). All match.

---

## HIGH — must resolve before implementing

### H1. `Checkpoint.fromStateStack` sources `nodeId` and `stack` from *different* stacks

`checkpointStore.ts:173-190`:

```ts
const nodeId = ctx.stateStack.currentNodeId();   // <- context's live stack
...
return new Checkpoint({ stack: stateStack.toJSON(), ..., nodeId });  // <- the PASSED stack
```

The serialized `stack` comes from the argument; `nodeId` always comes from
`ctx.stateStack`. They only agree when the passed stack **is** `ctx.stateStack`.
The plan calls `create()` with non-context stacks in two places:

1. **Task 1 (D2), the "defensive slice" path.** The whole selling point of D2 is
   that on "a branch-like stack that somehow lacks a coordinator" it captures the
   *local slice* (`stack`) instead of the root. But `nodeId` will still be pulled
   from `ctx.stateStack` (the outer node). The resulting checkpoint has a branch
   slice + an outer nodeId — on restore, `runResumeLoop`/`rewindFrom` set
   `nodeName = cp.nodeId` and resume the *wrong* node with slice frames. That is
   not "strictly less wrong than capturing the root"; it's a different kind of
   wrong. At the genuine top level `stack === ctx.stateStack` so it's fine — but
   the defensive branch the plan advertises is where it bites.

2. **Pure-round stamp (D10).** `resolvePureRound` does
   `ctx.checkpoints.create(parentStack, ctx, ...)`. D10 asserts "nodeId ... correct
   at the outermost stamp." This is true **only if** the outermost batch's
   `parentStack === ctx.stateStack`. That holds for a top-level `fork`, but the
   plan never states or asserts this invariant, and it is *not* obviously true for
   a `fork` reached inside an async-called function or inside `runPrompt`'s tool
   loop (E16), where the enclosing `runBatch`'s `parentStack` may be a sub-stack.

**Action:** Either (a) add an explicit invariant + assertion that pure-round
stamping only ever happens when `parentStack === ctx.stateStack` (and prove it for
the tool-loop path in Task 6/E16), or (b) fix `fromStateStack` to derive `nodeId`
from the passed `stateStack` (`stateStack.currentNodeId()`), which is the value
that actually corresponds to the frames being serialized. Option (b) is the
smaller, safer change and also makes Task 1's D2 path correct. Whichever you pick,
add a test asserting `cp.nodeId` matches the node the serialized top frame belongs
to, for a stamp taken via `runBatch` (not just top-level solo).

---

## MEDIUM

### M1. `checkpoint()` return-type union isn't propagated to its wrapper

`checkpoint()` becomes `Promise<number | Interrupt[]>` (Task 4), but the only
non-generated TS consumer, `lib/runtime/agency.ts:263`
(`const checkpoint = (): Promise<number> => _checkpoint();`), is typed
`Promise<number>` and will fail to typecheck. It's not in Part 2's file list and
no task touches it. Add it explicitly to Task 4 (and double-check whatever the
generated code imports resolves to the widened type).

### M2. `runRaceResume` bypasses `startInvoke` — coordinator wiring won't reach it via Task 3

Task 3 installs `stack.batchCoordinator` inside `startInvoke`, and its Interface
section claims "**Every** non-cached child branch stack gets `stack.batchCoordinator`
set." That's false for the race-resume path: `runRaceResume` (`runBatch.ts:689`)
does **not** call `startInvoke`; it inlines `rehydrateInheritedGuards` →
`composeBranchAbortSignal` → `runInBranchAlsFrame` at `runBatch.ts:721-741`. The
plan *does* remember this in Task 7 Step 3 ("Also apply the coordinator wiring to
`runRaceResume`"), so it's not missed — but Task 3's stated postcondition is
inaccurate and the wiring is easy to drop. Recommend: soften Task 3's Interface
claim to "all-, sequential-, and race-first-time modes," and make Task 7 Step 3's
race-resume wiring a checkbox of its own rather than a clause.

### M3. `ctx.pendingPromises.awaitAll()` from inside a parking branch is unexamined

The concurrent path keeps `await ctx.pendingPromises.awaitAll()` before parking.
`pendingPromises` is **context-global**, not branch-local. Calling it from within
one fork branch awaits *every* branch's in-flight async work. In the solo path this
is the "don't lose unawaited async" guard; in the concurrent path the actual
snapshot happens later in `runBatch` after the barrier, so this call is at best
redundant and at worst couples sibling progress into A's park (A can't park until
B's unawaited async settles — and if B is itself heading for a checkpoint, reason
about whether that can wedge the barrier). The plan should either justify keeping
it or scope it to the solo branch (`if (!coordinator) await ...awaitAll()`).

---

## LOW / polish

- **L1. `runInBranchAlsFrame`'s `!parent` early return** (`runBatch.ts:327-333`)
  returns `fn()` without `agencyStore.run(...)` **and** therefore without the new
  snapshot registration Task 3 Step 2 adds "before `await fn()`". A batch whose
  branches hit that path won't register per-branch snapshots. Real-world impact is
  low (production runs always have a parent frame; this is mostly a direct-call/test
  path), but note it, and note that the coordinator is still reachable there because
  it lives on `branch.stack`, not the ALS frame.
- **L2. Marker field naming.** `interrupt()` populates `data`, not `interruptData`
  (`interrupts.ts:64,80`). `recordSettle` (plan's Task 3) reads
  `s.value[0].interruptData` when calling `setInterruptOnBranch`. Confirm real
  interrupts actually carry `interruptData` (vs `data`) at that point, and that a
  marker storing `undefined` interruptData is harmless (its data is `{}` anyway).
  If the existing collect loop already reads `.interruptData`, this is pre-existing
  and fine — just verify, don't assume.
- **L3. `recordOutcomes` vs `recordBranchOutcomes`.** The opts field is
  `recordBranchOutcomes`; `recordOutcomes` is only the local
  (`runBatch.ts:465`). The plan uses the local name in `recordSettle`, which is
  correct — just don't let it drift into an opts reference.
- **L4. Step 2/3 framing.** "Step 2 (settle) / step 3 (collect)" via
  `Promise.allSettled` is accurate only for `mode:"all"`; `sequential` uses an
  await-loop and `race` never enters that block (`runBatch.ts:477`). The
  restructure in Task 3 handles both, but the prose could mislead an implementer
  into thinking there's a single `allSettled` site.

---

## Design-level observations (not blockers)

- **D4 handler bypass is the single most safety-sensitive decision** and is
  correctly reasoned: real interrupts still flow through `interruptWithHandlers`;
  only markers skip it, and a marker only exists because a *real* interrupt already
  ran handlers. This aligns with the project rule that handlers must never be
  skipped for a real interrupt. Flag it for extra scrutiny during code review of
  Task 5, and make E4's "checkpointed appears exactly once" assertion a hard
  failure, not a soft check — it's the guard against the double-execution bug.
- **Barrier-blocks-forever cost (D5)** is inherent and honestly documented. Worth
  a defensive log/telemetry when a batch has been parked-without-progress for a
  long time, so a livelocked run is diagnosable rather than a silent hang — could
  be a follow-up, not this PR.
- **Task sequencing is genuinely incremental and TDD-first**, existing runBatch
  suite as the Task 3 safety net is the right call, and the edge-case→test table is
  excellent. No notes there.

## Suggested pre-flight before Task 1

1. Decide H1 option (a) vs (b); if (b), it's a one-line change that also unblocks a
   clean Task 1.
2. Add `lib/runtime/agency.ts` to the Task 4 file list (M1).
3. Verify M2/M3 anchors by grep before writing code so the race-resume and
   `interruptData` details are pinned.

---

# Anti-pattern pass (`docs/dev/anti-patterns.md`)

Checked the plan's code snippets against the catalog, with focus on the
"declarative code encapsulating imperative complexity" question.

## Headline answer: yes — and, in one dangerous spot, the exact opposite

The plan's **primary abstraction, `BatchCoordinator`, is a textbook-correct
application** of the "imperative code everywhere" cure. The genuinely messy
imperative work — barrier accounting (`started === settled + parked.length`),
promise juggling, drain-before-resolve ordering — is sealed inside the class, and
`runBatch`/`checkpoint()` consume it declaratively (`park`, `continueParked`,
`unwindParked`, `abortParked`, `snapshotParked`, `barrier`). That is the "what vs
how" split the doc wants. Good, and worth preserving as-is.

**But at the one boundary where it matters most for safety — the interrupt-resume
protocol — the plan does the inverse: it duplicates imperative complexity instead
of encapsulating it.** This is the most important anti-pattern finding.

### AP1. Duplicating existing code + leaky abstraction — the marker dance (HIGH)

Task 4's concurrent `checkpoint()` re-hand-rolls, almost line-for-line, the
discipline that `agencyInterrupt.ts:148-190` already owns:

| plan's Task-4 `checkpoint()` | existing `agencyInterrupt.ts` |
|---|---|
| ``const key = `__interrupt_${location.stepPath}` `` | ``const key = `__interrupt_${callsite.stepPath}` `` (`:148`) |
| `const persistedId = frame?.locals[key]; if (persistedId !== undefined) { const resp = ctx.getInterruptResponse(persistedId); ... }` | identical (`:154-158`) |
| `frame.locals[key] = intr.interruptId;` (persist BEFORE stamp) | identical (`:183`) |
| `ctx.checkpoints.create(stack, ...); intr.checkpointId = ...; intr.checkpoint = ctx.checkpoints.get(...)` | identical (`:184-190`) |

D3 openly says it "mirrors `agencyInterrupt.ts`'s discipline exactly." That is the
"Duplicating existing code" anti-pattern (§ *Duplicating existing code*) stated as a
design goal. It also trips "Leaky abstractions": the `__interrupt_${stepPath}`
local-key convention and the persist-before-stamp ordering are *internal details of
the interrupt-resume protocol* that now leak into a second file — this is nearly the
doc's bad example verbatim (reaching into `stack.locals.__…`). The two copies can
silently diverge: if `agencyInterrupt.ts` ever changes the key format, the halt
payload shape, or the ordering, `checkpoint()` breaks with no compile error.

**Recommendation:** extract the shared tail of `agencyInterrupt.ts` (persist id →
stamp → attach checkpoint, plus the resume short-circuit) into one reusable helper —
e.g. `resumeShortCircuit(rt): InterruptResponse | undefined` and
`emitInterruptCheckpoint(rt, intr): void` — and have both `agency.interrupt()` and
`checkpoint()` call it. `checkpoint()`'s only real deltas are (a) it skips
`interruptWithHandlers` (D4) and (b) it parks first; everything after that should be
the *same* code, not a copy. This directly serves the "encapsulate the how in one
place" rule, removes the leak, and de-risks H1 (single stamp site to get nodeId
right). Add this as an explicit step in Task 4 / restructure Task 5.

### AP2. Nested ternary — `buildResponseMap` (MEDIUM; direct ban)

Task 5's leniency check is a nested ternary, which the catalog bans outright
(§ *Nested ternaries*):

```ts
const zipTargets =
  responses.length === interrupts.length ? interrupts
    : responses.length === real.length ? real
      : undefined;
```

Rewrite as an `if/else if/else`. Trivial, but it's an explicit rule and it's in a
correctness-sensitive spot (response mispairing), so clarity matters.

### AP3. One-line `if` statements — pervasive (LOW; partly matches house style)

The catalog bans single-line `if` bodies (§ *One-line if statements*). The snippets
use them widely: `if (firstError !== undefined) throw firstError.err;`,
`if (!t.cached) hooks?.onBranchEnd?.(…)`, `if (recordOutcomes) parentFrame.set…`,
`if (frame) frame.locals[key] = …`, `if (isCheckpointMarker(it)) continue;`, the
final collect `if (…) interrupts.push(…)`.

Caveat: some *mirror existing* one-liners in `runBatch.ts` (e.g. `:383`
`if (!shareGlobals) branch.globalsJSON = …`). There's real tension here between the
"be consistent with surrounding code" rule (§ *Inconsistent patterns*) and this ban.
Guidance for the implementer: where you're editing next to existing one-liners,
matching them is fine; net-new standalone statements should use braces.

### AP4. Order-dependent mutable state (LOW; mostly inherent)

Two spots touch § *Order-dependent mutable state*:

- The marker path's "persist the id **before** stamping" is a hard ordering
  requirement (the doc's exact concern). It's inherent to resume idempotency — but
  that's a *second* reason to fix AP1: the fragile ordering should live in one
  helper, not be re-typed correctly in two files.
- `settleRounds` branches on mutable `firstError` / `interruptSeen` accumulated by
  the separate `recordSettle` closure. The round decision (error → mixed → pure) is
  read out of mutating flags rather than derived. Largely inherent to a barrier
  loop, but a small `classifyRound(): "error" | "mixed" | "pure" | "done"` deriving
  the decision from current state would read more declaratively and make the
  precedence (error beats interrupt beats pure) explicit in one place.

### AP5. Single-character variable names (LOW)

Production snippets use `t` (task), `s` (settled result), `p` (parked entry),
`w` (waiter), `ps`, `ev`, `res` (§ *Single character variable names*). Loop indices
`i` are fine; the domain objects (`task`, `settled`, `parkedEntry`, `waiter`) should
get real names in the shipped code. Test snippets are more forgiving.

## Anti-patterns the plan correctly AVOIDS (credit where due)

- **Duplicating resume logic is actively *removed*, not added:** Task 8 collapses
  `rewindFrom`'s inlined resume loop (which today duplicates `runResumeLoop`) and
  `respondToInterrupts` onto one `resume` core. That's the § *Duplicating existing
  code* cure applied deliberately — good, and it partially offsets AP1 if you fold
  the marker helper in at the same time.
- **No useless special cases, no dynamic requires, no empty catch blocks, no deeply
  nested type literals** in the snippets (`ParkResolution` is a clean flat union).
- The `BatchCoordinator` interface is a genuinely clean abstraction boundary — you
  can understand `runBatch`'s round loop without reading the coordinator internals,
  which is the opposite of § *Leaky abstractions*.

## Bottom line

The plan's structural instinct is right — it encapsulates the hard concurrency
"how" behind `BatchCoordinator` and consumes it declaratively. The one place it
regresses is **AP1**: it treats "mirror `agencyInterrupt.ts` exactly" as acceptable
duplication when that shared discipline should be one extracted helper. Fixing AP1
(plus AP2's nested ternary) resolves the substantive anti-pattern content; AP3–AP5
are style cleanups to apply while implementing.
