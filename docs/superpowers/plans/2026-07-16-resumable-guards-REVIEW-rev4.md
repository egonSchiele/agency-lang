# Plan review: resumable guards, rev 4 (2026-07-16)

**Reviewing:** `docs/superpowers/plans/2026-07-16-resumable-guards.md` (rev 4)
**Supersedes:** the rev-3 review.
**Verdict:** The prose rewrite worked — Part 1 is genuinely useful context and
the trip-site taxonomy is the right instrument for the question it answers. Four
of the six rev-3 findings are fixed correctly. But **the two blocking ones are
not fixed; they are re-stated with new mechanisms that fail the same way**, and
in one case the plan's justifying sentence is contradicted by
`docs/dev/interrupts.md`. There is also a third enforcement surface the plan does
not know about, and the change it proposes there would silently stop enforcing.

All line references are `packages/agency-lang/`. Everything below was checked
against the code and docs today.

---

# The pattern worth naming first

This plan has now tried three times to connect "a handler" to "some guards"
across a checkpoint, and rev 4 also needs to connect "a trip" to "its answer"
across one. The four attempts:

1. Rev 2: guard-array **depth**. Killed — joins a replayed structure to a
   restored one.
2. Rev 3: a **serialized ordinal counter**. Killed — replay keeps counting, so
   the memo never hits.
3. Rev 4: an **in-memory ordinal counter**, reset per process. Killed below.
4. Rev 4: a **serialized generation counter** for the trip id. Killed below.

Every one is a count of things that happened. That is the common factor, and it
is why they keep failing: **replay does not re-run what happened. It re-runs the
path to the checkpoint.** Completed work is skipped on purpose — that is the
entire function of the step counters (`docs/dev/interrupts.md:18`: "statements
with lower indices are skipped").

The codebase already has two proven replay-stable keys, and neither counts
anything:

- `agencyInterrupt` keys persisted interrupt ids by **callsite**, stored **per
  frame**: `frame.locals[\`__interrupt_${callsite.stepPath}\`]`
  (`agencyInterrupt.ts:152-162`). The compiler determines the key; execution
  history does not.
- #551's `draftRegionStart` keys by **content**: `stack.other.draftRegions[ids.join(",")]`.
  The data determines the key.

So the rule for this plan, worth writing into it as a constraint rather than
rediscovering a fifth time: **a key that must survive replay is derived from
position or from data, never from a count of executions.** Both blockers below
are the same task, and they should be designed together.

---

# Blocking

## 1. The in-memory ordinal is not replay-stable, and the sentence justifying it is false

Section 1.3b says:

> Replay re-executes every registration of the branch from the top, in the
> original order (that is what replay is), so the counter reproduces the
> original ordinals.

That is not what replay is. Replay re-enters the code and **skips completed
work**:

- `docs/dev/interrupts.md:18` — "On resume, statements with lower indices are
  skipped, and execution picks up at the right statement."
- `docs/dev/interrupts.md:157,184` — completed loop iterations are skipped
  outright: `if (__currentIter_K < __stack.locals.__iteration_K) { __currentIter_K++; continue; }`.

So the registrations that re-execute on replay are only the ones still **open**
at checkpoint time. Every `handle` block that already finished and popped is
skipped — and its ordinal disappears from the sequence.

**The simplest break needs no loop at all.** Two sequential handle blocks in a
node:

```
handle { setupWork() } with (i) { ... }      // registration ordinal 0, completes, pops
handle {                                      // registration ordinal 1
  guard(cost: $1) as { codingAgent(task) }    // trips, propagates, CHECKPOINT
} with (i) { ... }
```

Original run: the first block registers at ordinal 0 and pops; the second
registers at ordinal 1 and memoizes its true id set at `__handlerGuards_1`.
Resume: the in-memory counter starts at 0, the first statement is skipped
(completed), so **the second block's registration is now the first one executed**
and asks for ordinal 0. It hits `__handlerGuards_0` — the *first* block's
memoized set — and adopts it.

Now `guardsHiddenFrom` computes "every installed guard whose id is not in that
set." The tripped guard was not live when the first block registered, so it is
not in the set, so it gets suspended while the second block's handler runs.
Fail-open metering — the exact bug decision 3 exists to prevent, on the exact
path (resume) the feature is for.

**The loop case is worse**, because `nextGuardId()` mints fresh ids per push
(`guard.ts:14-18`): iteration 4's handler would adopt iteration 1's ids, which
name none of iteration 4's live guards, so *every* enclosing guard gets
suspended. Task 1.3's test 5 ("loop registration") is aimed at this and is a good
instinct — but it would only catch it if the fixture checkpoints mid-loop, and as
written ("two iterations, each pushing its own guard") it may not.

**What to do.** Use the `agencyInterrupt` pattern, which is the same problem
already solved: store the memo **on the frame, keyed by the registering
callsite's `stepPath`**, not on the stack keyed by an ordinal. Frames are
serialized and restored; replay re-enters the same frame and computes the same
key; a completed sibling's key is a different string, so skipping it costs
nothing. Whatever you pick, it has to be shown to survive three shapes before
execution, because these are the shapes that break counters:

1. two sequential `handle` blocks, checkpoint inside the second;
2. a `handle` inside a loop, checkpoint in a later iteration;
3. a `handle` inside a recursive function, checkpoint in a deeper call.

(3) is the one that will decide the design: same callsite, different frames — so
frame-scoped storage handles it and a stack-wide map keyed by callsite alone does
not.

## 2. The trip generation counter cannot satisfy both of its requirements

Task 2.2 keys the trip interrupt `__guardTrip_<scope>#<generation>`, with
`generation` a per-scope counter "serialized in `stack.other`, incremented at
each NEW raise." This is the fix for rev-3's auto-approve-forever bug, and it
does fix *that* — but it breaks resume idempotency, which is the property the key
exists to provide.

The key has two requirements, and they pull against each other:

- **Stable across replays of the same trip.** On resume, the pre-call gate
  re-runs, the guard is still over budget (the approve is applied by the code
  *after* the raise returns, which has not run yet), so the raise site is
  re-reached. It must produce the *same* key, find the persisted id, and return
  the recorded answer. That is the whole mechanism (`agencyInterrupt.ts:158-162`).
- **Distinct across successive trips.** Otherwise trip #2 finds trip #1's
  answer — rev-3's blocker.

A counter incremented at raise time fails the first: the replayed raise
increments again, gets `#1` instead of `#0`, misses the recorded answer, and asks
the user a second time. Then the resumed run replays again and asks a third time.
Moving the increment to answer-time fails the same way one step later — any
subsequent replay re-reaches the raise with the counter already bumped.

**This is blocker 1 again**, which is why they should be designed together. The
way out is the same: derive the generation instead of counting it. One
illustration of the shape (not a recommendation — the point is the shape): the
guard's own `costLimit` is stable for the whole life of a trip and *changes* the
moment an approve is applied, so a key like `__guardTrip_<scope>@<costLimit>` is
identical on every replay of one trip and different after a grant. Time and
disarm complicate it. But it is content-derived, which is the property that
matters, and it is the #551 pattern.

Worth repeating from the rev-3 review: **the headline fixture catches this**
("after an approved trip and more spending, the SECOND trip must actually
raise"). Keep it, and add its twin — after a *propagated* trip is answered and
the run resumes, the user must not be asked twice.

---

# Substantive

## 3. Cost trips have four enforcement sites, not two — and the proposed change silently disarms two of them

Part 1.1 states that cost guards "trip at exactly two places, both inside
`runPrompt`," and the taxonomy table in Task 2.2 has exactly three rows. There
are four callers of `enforceGuards()`:

- `prompt.ts:554` — the pre-call gate (taxonomy row 1). ✅
- `prompt.ts:699` — the post-charge check (row 2). ✅
- **`cost.ts:12`** — `addCost(amount)`, the public helper a TS-side paid call
  site uses so its spend participates in `getCost()` and `guard(cost:)`. Its own
  docstring says: *"Throws (a guard-trip) if enforcement fails — callers must not
  swallow it."*
- **`ipc.ts:897`** — `handleTelemetryMessage`, where a subprocess child's
  reported cost is billed to the parent's guards. The throw is caught and turned
  into `killChildSafely(s)` + settle.

Three consequences:

**(a) The `enforceGuards` refactor is not a style choice.** Task 2.2 says to make
it "RETURN the offending guard rather than throw, or gain a sibling that does;
pick whichever reads cleaner at both call sites." There are four call sites, and
two of them are outside the file the task is editing. If `enforceGuards` changes
in place, `addCost` and the IPC telemetry handler keep calling it, ignore the
returned guard, and **stop enforcing** — fail-open at the subprocess budget
boundary, which is the operator-facing one. The sibling is mandatory; the
existing method must keep throwing.

**(b) The IPC site structurally cannot raise.** `handleTelemetryMessage` is a
message callback, not a step body: there is no runner in the ALS frame, and
`agency.interrupt` throws without one (`agencyInterrupt.ts:129-137`). So a
child's spend tripping the parent's guard has to keep today's hard-kill
behavior — while an identical trip from an in-process `llm()` becomes
approvable. That asymmetry is defensible (it mirrors "root budgets stay hard")
but it is invisible today and needs a row in the taxonomy and a line in
`guards.md`.

**(c) `addCost` sites can raise but the plan does not say whether they do.**
They run inside a step body with a live frame, so the machinery would work.
Leaving them throwing means `guard(cost:)` around a TS-helper paid call behaves
differently from `guard(cost:)` around `llm()` — same user-visible construct,
two semantics. Pick one and write it down.

The taxonomy table is the right instrument. It just needs the two missing rows,
and Part 1.1's "cost only changes when LLM calls happen" needs the correction
that `addCost` exists precisely because that is not true.

## 4. "Correct-by-reconstruction" relabels the dedupe hole rather than closing it

Task 2.2 says the pending-trip record is live-only, and that losing it across a
checkpoint is "correct-by-reconstruction: restored branches re-detect and
re-raise, and the serialized generation counter keeps their keys fresh."

Re-raising is what the dedupe exists to prevent. Three branches re-detect, three
trips raise, the handler grants $0.50 three times, and the limit rises $1.50 —
decision 10's over-grant, back, on the resume path. The sentence describes the
mechanism accurately and then names the outcome the opposite of what it is.

Either serialize enough state to dedupe after a restore, or say plainly:
"dedupe is best-effort within one process lifetime; across a resume, concurrent
branches can each obtain a grant." Both are legitimate; only one is written down.
If it is the second, the shared-guard dedupe fixture should have a resumed twin
that pins the documented-and-accepted behavior, so nobody later reads the
over-grant as a regression.

## 5. The signal audit is a vigilance rule, and this plan rejects vigilance rules everywhere else

Task 3.1 replaces the accumulated chain with a rebuilt composite, then adds:
"grep every reader of `stack.abortSignal` and confirm each reads at use time
rather than caching across an approve boundary."

That audit is correct today, and it is a standing obligation on every future
reader — the same "remember to keep these in sync" pattern this plan
(rightly) refuses elsewhere: suspension went onto the `Guard` interface
specifically so call sites could not forget, and the merge table was made total
specifically so no caller has to special-case a gap.

A stable per-stack `AbortController` whose *subscriptions* are rebuilt makes the
question unaskable: the signal object never changes, so no reader can hold a
stale one, and the grep never needs repeating. The plan's own argument for why
minting is safe ("in-flight operations that captured the OLD signal were exactly
the operations the trip cancelled") is sound for the trip case, but
`rebuildAbortSignal` is also called on guard push/pop, where it is not obviously
true, and the getter (`get abortSignal()`) only protects readers that call it at
use time — which is precisely what the audit is checking. Keep minting if you
prefer, but then say why vigilance is acceptable here and structural enforcement
was required for suspension.

## 6. Option A's join rule extends the parent by the wrong quantity

Task 3.3: "`runBatch`'s join reads each clone's granted-delta and extends the
parent by the **max delta** before `addElapsed`."

The parent is charged the max **working time**, not the max delta, and those can
belong to different branches. If branch A was granted +5m and worked 15m while
branch B was granted +8m and finished at 12m, the parent gets charged A's 15m and
extended by B's 8m — three minutes of headroom nobody consumed. The rule that
matches Option A's own rationale ("you approved five more minutes of work; you
get them") is: **extend by the delta granted to the branch whose working time the
parent is charged.** Worth fixing in the text now; it is the kind of thing that
ships as written.

---

# Smaller notes

- **Task 1.3a's sentence is cut off**: "…the cross-object field-reaching pattern
  flagged on" — ends mid-clause (it means #553's review).
- **Task 1.2's IPC default merge** is subtle and correctly flagged: `(inner,
  outer) => outer ?? inner` for the default path only, preserving today's
  "valueless outer approve defers to inner over IPC." Good catch keeping that
  nuance; the comment it asks for is worth two sentences rather than one, since
  the in-process default is deliberately *different* (`(_inner, outer) => outer`,
  unconditional overwrite). Two defaults with one name will confuse someone.
- **Task 1.1's typechecker claim** ("that is the whole typechecker change")
  reads right to me: `approve`/`reject`/`propagate` are plain `ANY_T` builtins,
  and the plan tells the executor to verify by grepping `propagate`'s wiring
  rather than trusting the claim. That is the right hedge in the right place.
- **Estimates** are still credible, though blockers 1 and 2 are now one shared
  design problem rather than two mechanical fixes; if that design takes a day, PR
  1 is 5–6.

# What is right

The rewrite achieved what it was for. Part 1 means a reader can start at the top
and arrive at the decisions already knowing why they are the decisions. The
taxonomy table converts "what happens on a trip" from a paragraph you have to
trust into a grid you can check — which is exactly how I found the missing rows,
so it did its job on its first outing. The time-trip analysis in Task 3.2 is the
strongest single section: (b) and (c) resuming in place with no thread surgery,
and (a)'s "the loop only ever has a request in flight when every prior `tool_use`
already has its result appended" — that is the argument that makes re-issue safe,
and it is proven from the structure rather than asserted.

Rev-3 findings 3 (suspend gates resume), 5 (cost-only dedupe), and 6
(`cloneForBranch` field copy) are folded correctly and with the reasoning
attached, which is why they will survive contact with an executor.

# Recommended next steps

1. Design the replay-stable key **once**, for both the handler memo and the trip
   id, and prove it against sequential blocks, loops, and recursion (blockers 1
   and 2). This is the whole remaining risk.
2. Add the two missing enforcement rows to the taxonomy and make the
   `enforceGuards` sibling mandatory (finding 3).
3. Decide and state the dedupe-across-resume behavior (finding 4).
4. Fix the join quantity to "the charged branch's delta" (finding 6).
5. Owner decides Part 3.
