# Plan review: resumable guards, rev 3 (2026-07-16)

**Reviewing:** `docs/superpowers/plans/2026-07-16-resumable-guards.md` (rev 3)
**Supersedes:** the rev-2 review + its two addenda.
**Verdict:** Every rev-2 finding, every anti-pattern item, and every test-plan
item is folded in — correctly, not cosmetically. `GuardScope`, the total merge
table, suspension-on-the-interface, and the derived signal are all the right
shape. What is left is smaller and more concrete than last round: **two keying
bugs that would ship silently, one mechanism that is cancelled out by existing
runtime behavior, and two design details that need naming.** Findings 1 and 2
are blocking; the rest are a morning's work.

All line references are `packages/agency-lang/`. Verified against the code today.

---

## Blocking

### 1. "Keyed by the branch-local registration ordinal (replay-stable)" is the same unestablished claim rev 2 made about depth.

Decision 4 and Task 1.3 fix the coordinate (identity, not index) and then key the
memo by "the handler's per-branch registration ordinal," asserting replay-
stability in parentheses. That parenthetical is doing all the work, and it does
not hold either way you can build it:

- **A monotonic counter** (the only way to avoid collisions on push/pop reuse —
  `withPushedHandler` pops in `finally`, so a naive "current handler-stack
  length" reuses key 0 for every sibling `handle`) lives in `stack.other`, so it
  serializes. On replay it keeps counting from the restored value, every
  registration gets a fresh key, every memo lookup misses, and the capture
  recomputes against the post-restore stack. That is the rev-2 blocker, intact.
- **A resetting or callsite-shaped key** collides across loop iterations, and
  first-write-wins then hands iteration 2 iteration 1's ids. This one is worse
  than it sounds: `nextGuardId()` mints a **fresh** id per push (`guard.ts:14-18`),
  so iteration 2's guard ids appear in no earlier iteration's set. A handler
  registered inside `for (...) { guard(...) as { handle {...} with {...} } }`
  would compute `guardsHiddenFrom` = "everything not in the stale set" = its own
  enclosing guard, and suspend the guard it is genuinely inside. Fail-open, on the
  metering path.

The plan is right that the memo is the #551 lesson; it picked the wrong half of
it. #551 keyed `stack.other.draftRegions` by **content** (`ids.join(",")`), and
`agencyInterrupt` keys its replay-stable state by **callsite**
(`__interrupt_${callsite.stepPath}`, `agencyInterrupt.ts:152`). Neither is an
ordinal, because an ordinal is a count of things that happened — exactly what
replay does not reproduce.

Name the key concretely and show it survives both a resume and a loop before
execution. This is the one item I would not let an executor resolve inline: it is
the same failure that has now been designed twice, and the second time it wore a
fix's clothes.

### 2. `__guardTrip_<scope>` auto-approves every later trip of the same scope.

Task 2.2 keys resume idempotency `__guardTrip_<scope>` in `stack.other`. The
`agency.interrupt` dance it reuses reads that key like this
(`agencyInterrupt.ts:158-162`):

```ts
const persistedId = frame.locals[key];
if (persistedId !== undefined) {
  const resp = ctx.getInterruptResponse(persistedId);
  if (resp) return resp;               // <-- short-circuit, no handlers, no checkpoint
}
```

A scope-keyed id is stable for the scope's whole lifetime. So trip #2 of the same
scope finds trip #1's persisted id, finds its recorded response, and **returns the
first approve verbatim** — no handler chain, no user, no new grant applied
correctly. A guard approved once is approved forever, silently, and the budget
stops meaning anything.

The key needs a per-trip generation (`__guardTrip_<scope>:<n>`, bumped when a trip
is answered and cleared). Rev 2's rationale for scope-keying — "the same trip must
be answerable no matter which step boundary sees it first" — is satisfied by a
generation too; it only needs to be stable *within* one trip, not across all of
them.

Worth saying: **the plan's own headline fixture catches this** ("approve → the
block resumes → a later trip still fires"). That is exactly the test-plan
discipline from the last round paying off. Fix the key anyway rather than
discovering it in execution.

---

## Substantive

### 3. `suspend()` via `pause()` is undone by the Runner on the next step.

Decision 5 says `TimeGuard.suspend()` pauses the clock, and Task 2.2 relies on it:
"the tripped clock freezes during deliberation."

But `Runner.beforeStep` (`runner.ts:265-267`) does:

```ts
this.stack?.guards.forEach((g) => g.resume(this.stack!));
```

unconditionally, at **every step-equivalent entry point** — and a handler body is
Agency code that executes steps. So the first step inside the handler un-pauses
every suspended TimeGuard and the clock runs for the whole deliberation. The
reviewer agent's thinking time is charged to the budget it was called to
adjudicate.

The fix is one line — `resume()` must no-op while `suspended` — but it has to be
*stated*, because nothing would catch it: freezing a wall clock is exactly the
category decision 14 says not to write fixtures for. Suggest making it a property
of the interface contract in `guard.ts`'s docstring (the lifecycle list at
`:20-59` is the place: suspension outranks pause/resume) plus a unit test on the
guard object — `suspend(); resume(stack); assert still paused` — which is
deterministic and cheap.

### 4. A derived signal recomposes into a *new object*, and in-flight readers keep the old one.

Task 3.1 is right and I still endorse it. One detail it needs: `AbortSignal.any([...])`
returns a fresh signal each time it is called, so every `recomputeAbortSignal()`
replaces `stack.abortSignal` with a new object. Anything that already read the
signal is now listening to a detached one — smoltalk took `ctx.getAbortSignal(stateStack)`
when the request was issued, and race-loser cancellation holds references too.
Under today's install/uninstall the swap happens rarely; under the new design it
happens on every arm, disarm, suspend, and unsuspend, i.e. constantly, and during
in-flight work by construction (that is the point of the feature).

Fail direction: a guard that arms while a request is in flight cannot cancel it.

The fix keeps the design and makes it better: give the stack **one stable
`AbortController`** whose signal is `stack.abortSignal` forever, and have
`recomputeAbortSignal` re-subscribe it to the armed guards' signals rather than
re-wrap them. References never go stale, `previousSignal` still dies, and re-arm
is still "recompute." Worth pinning: arm a guard mid-flight → the in-flight op
still aborts.

### 5. The dedupe marker's placement decides its semantics, and the plan does not say so.

Decision 12 says "dedupe per scope"; Task 2.2 implements it as "the shared guard
object holds a live (unserialized) pending-trip marker." Two consequences the plan
should state outright, because an executor reading "per scope" will build it
differently:

- **It is cost-only, and that is correct.** `CostGuard.cloneForBranch` returns
  `this` (`guard.ts:210`) so branches share one object and one marker. `TimeGuard`
  clones are separate objects (`guard.ts:421-424`) carrying separate budgets — N
  branch trips there are N *real* budgets, and N grants are right, not an
  over-grant. An executor who hoists the marker onto the scope (as "per scope"
  implies) would dedupe unrelated time trips and silently under-grant. Say
  "shared-object dedupe, which is cost-only by construction, and time clones are
  intentionally exempt."
- **Unserialized means the over-grant returns across a checkpoint.** Branch trips,
  propagates to the user, run checkpoints; on resume the marker is gone and the
  siblings raise again. The window is narrow but it is the resume path, which is
  the path this feature exists for. Either serialize the marker (and own its
  cleanup) or document that dedupe is best-effort within a process lifetime.

### 6. `scopeIds` will not reach time clones.

Task 2.1 says each member is stamped with the scope's id array, "serialized on
`GuardJSON` like `guardId`, so clones and resume keep it." Serialization covers
resume; it does not cover clones. `TimeGuard.cloneForBranch` (`guard.ts:421-424`)
builds a fresh object and copies fields **by hand** — `clone.guardId = this.guardId`
is the only one today. Without an explicit `clone.scopeIds = this.scopeIds`, a
branch's clone resolves to an empty scope and approve fails on exactly the
fork path. One line, easy to miss, and `guardId` is the precedent showing the
pattern is hand-maintained.

---

## Smaller notes

- **Decision 3's breaking change needs a witness.** Task 1.3 requires the existing
  handler/interrupt suites green on the new entry shape before new tests land —
  right for safety infrastructure. But if registration-site metering is genuinely
  breaking for ordinary interrupts, at least one existing fixture should move. If
  literally nothing changes, treat that as evidence the new path is not reached,
  not as evidence of safety, and go find why.
- **Task 3.3 gate:** I agree with the recommendation — the grant follows the
  budget. The user approved five more minutes against the guard they named; a trip
  immediately after the join, with no work in between, is the surprising outcome,
  and "surprising" is expensive in a feature whose whole purpose is a human
  deciding to continue. The branch-local reading is defensible but the burden of
  documentation it carries is heavier than the implementation it saves.
- **Estimates** are now credible. PR 2 at 5–6 days is the right shape given
  `GuardScope` + dedupe + the audit.

## What is right

The fold is honest. `GuardScope` is the abstraction the runtime was missing and it
absorbs four rules that were prose (fork resolution, root refusal, livelock,
snapshot) into one resolver. Cutting `defineInterruptMerge` to #555 while keeping
a total constant table gets the semantics with none of the surface. Suspension on
the `Guard` interface leaves `enforceGuards` untouched, which is what the
interface promised. And the test plan is now the strongest part of the document:
spend-into-the-gap is the right universal discipline, the headline
approve-across-a-checkpoint fixture is the one that would have caught the most,
and it catches finding 2 above for free.

## Recommended next steps

1. Name the memo key concretely and prove it against a resume **and** a loop
   (finding 1).
2. Add the trip generation to the interrupt key (finding 2).
3. Add the three one-liners: `resume()` no-ops while suspended, the stable stack
   controller, `clone.scopeIds` (findings 3, 4, 6).
4. State the dedupe marker's cost-only scope and its checkpoint caveat (finding 5).
5. Owner decides Task 3.3.
