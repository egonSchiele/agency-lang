# Review: Orphaned tool_use Repair Implementation Plan

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-22-orphaned-tool-use-repair.md`
against the code as of 2026-07-22 on branch `adit/subagent-failures-not-strings`.

Everything below that says "verified" means I read the file and line named.

## Overall

The plan is in good shape. The seam choice is right and I confirmed the two
claims it rests on:

- `Runner.thread()` really is the only non-test caller of both
  `resumeExisting` and `openSession` (`lib/runtime/runner.ts:690` and
  `:698`; the only other hits are comments and
  `lib/runtime/__tests__/testHelpers.ts:55-56`). So the seam covers both
  reopen modes with one call site.
- `isResumption` is set true on both paths — `continueId` at `runner.ts:691`
  and an existing session at `runner.ts:699-700` — and the insert point the
  plan names (just before `this.frame.locals[threadKey] = tid;` at
  `runner.ts:706`) is inside the branch that a checkpoint resume skips.

Task 1's claim about labels is also right. `markThreadCancelled` ends with
`messages.setMessages(repaired)` at `threadRepair.ts:77`, and `setMessages`
with no `labels` argument resets every label to null
(`messageThread.ts:96-105`). Switching to `push` (`messageThread.ts:126`)
does preserve them. So "strictly better" is accurate, not optimistic.

The rest of this is what I'd change before executing.

## Must fix

### 1. The "no `??` operator" constraint is wrong

Global constraint line 19 says: "No `??` operator — use an `if` against
`null`." That is false. `lib/agents/agency-agent/lib/budget.agency:186` and
`:191` both use it:

```agency
maxTime: overshoot + (decision.extraSeconds ?? 60) * 1000,
```

This matters because Task 6's code is written awkwardly to obey a rule that
does not exist:

```agency
let who = "a subagent"
if (intr.data.label != null) {
  who = intr.data.label
}
```

can just be `const who = intr.data.label ?? "a subagent"`. Delete the
constraint, and simplify the Task 6 snippet.

### 2. Task 6 quietly drops the interactive prompt, and that costs the user something

The spec offers two shapes for the catch-all (spec lines 448-451): reject, or
"in interactive mode, prompts the user the way `turnBudgetHandler` already
does for its own label." The plan picks reject-always plus a printed notice,
and never says it made that choice.

The consequence is real: after this change, an interactive user can no longer
grant more time to a subagent whose own budget ran out. Today they cannot
either (the trip parks forever), so this is still an improvement — but it is a
door being closed, and the plan should say so on purpose.

Two things to add:

- State the decision and the reason in Task 6's preamble. The honest reason is
  that prompting for a foreign guard needs an answer path that can express
  "extend *that* guard", and `approve({maxTime:...})` from an outer handler on
  an inner guard is a different question than the one `turnBudgetHandler`
  answers for its own label. If that is not the reason, say what is.
- Note the knock-on for Task 7. If every foreign guard is rejected regardless
  of label, the labels only ever feed a print statement. Task 7's own note at
  line 906 admits this ("nothing matches on their absence"). That is a weaker
  case for Task 7 than the task's opening sentence implies. Keep Task 7 — the
  notice really is better with a name in it — but do not oversell it.

One piece of supporting evidence the plan should include, because it is the
thing that makes reject-always safe: nothing outside `turnBudgetHandler`
wants to answer these trips today. `turnBudgetHandler` is registered at
`lib/agents/agency-agent/lib/coordinator.agency:362`, and the CLI policy
handler outside it passes on `std::guard`. So rejecting does not steal an
answer from anyone who would have given one.

### 3. Task 6's test proves too little, and the plan's salvage claim is unverified

Task 6 asserts the trip "converts to a `Failure` at the guard site, where the
caller salvages via finalize or draftValue like any other guard failure"
(plan line 732, again at 825). The test only checks `failure:true`. It never
shows a salvaged value coming back.

That gap matters because salvage across nested guards is exactly the thing
that has bitten this codebase before: a partial saved inside a subagent does
not automatically cross the subagent's own guard boundary. The existing
fixture `tests/agency/guards/turn-budget-partial.agency:33-36` documents the
workaround (read `i.data.draftValue` in the handler) precisely because the
naive path does not work.

So: extend the fixture in Task 6 to give `innerConsult`'s guard a `finalize`
block returning a known partial, and assert that partial comes back through
the `Result`. If it does not come back, that is a finding, not a test bug —
and better to learn it in Task 6 than after the PR.

### 4. Task 6 does not decide what happens to `_lastPartial`

Both existing reject paths set `_lastPartial = intr.data.draftValue` before
rejecting (`budget.agency:151` and `:169`) so `runTurn` can show the partial.
The new foreign-guard reject sets nothing, and the plan does not mention it.

I think not setting it is correct — the foreign guard's own salvage runs at
its own guard site, and the turn is not over, so overwriting the turn-level
partial would be wrong. But that is a judgement call sitting silently in the
diff. Write the reason into the plan (and probably into a comment).

### 5. Task 5 never proves the check is wired up

The spec lists this as required new behavior (spec line 498): "After repair
fires on a thread, answering the abandoned interrupt fails with a clear error
instead of restoring the stale snapshot into the thread."

Task 5 unit-tests `assertSnapshotNotStale` in isolation — two threads, two
numbers, a throw. That tests arithmetic. Nothing in the plan tests that the
function is actually called on the restore path, so a botched wiring in
`prompt.ts` ships green.

Add a test at the restore level: construct the `self.messagesJSON` /
`args.messages` pair the restore block consumes (`prompt.ts:1041-1052`), with
the live thread at `repairs: 1` and the snapshot at `0`, and assert the
restore throws. If `runPrompt` is too heavy to drive directly in a unit test,
say so in the plan and name what you are doing instead — do not leave the
requirement looking covered when it is not.

### 6. Say out loud why the assert must come before `adoptFrom`

Task 2 makes `adoptFrom` copy `repairs` (plan line 293). Task 5 puts
`assertSnapshotNotStale` immediately before the `adoptFrom` call. Those two
facts together mean the ordering is load-bearing: `adoptFrom` overwrites
`live.repairs` with the snapshot's value, so moving the assert one line down
silently disables it forever.

I verified `prompt.ts:1048` is the only non-test caller of `adoptFrom` in
`lib/`, so there is exactly one place to get this wrong — which is good, and
also why nobody will remember. Put a sentence in the code comment at the call
site, not just in the plan.

## Accuracy fixes

### 7. The two `lib/eval` files need no change

Task 4 lists `lib/eval/types.ts` and `lib/eval/normalize.ts` as "Modify … IF
they enumerate event types", and Step 3 tells the implementer to grep. I ran
the grep: `lib/eval/types.ts:62` and `lib/eval/normalize.ts:84` mention
`threadResumed` only inside prose comments. There is no enumeration and no
switch. Drop both files from the Files list and from the `git add` in Step 6,
and drop the conditional wording — it reads as uncertainty the plan does not
need to have.

The statelog call pattern the plan proposes is fine, incidentally:
`this.ctx.statelogClient?.threadEndHookError?.({...})` at `runner.ts:792` is
the existing precedent for the optional-chained, un-awaited call.

### 8. Task 7 undercounts the unlabeled guards by an order of magnitude

The plan names two known sites and gestures at "any other". There are 14:

```
stdlib/agents/coding.agency:125        stdlib/agents/agency/expert.agency:80
stdlib/agents/data.agency:131          stdlib/agents/agency/review.agency:124
stdlib/agents/expert.agency:92         stdlib/agents/agency/coding.agency:275
stdlib/agents/explorer.agency:180      stdlib/agents/agency/researcher.agency:90
stdlib/agents/oracle.agency:153        stdlib/agents/agency/verifier.agency:120
stdlib/agents/researcher.agency:135
stdlib/agents/verifier.agency:92
stdlib/agents/planner.agency:249
stdlib/agents/review.agency:93
```

Two things follow. First, list them in the plan so the task is a known
quantity rather than a grep-and-see. Second, the naming rule ("the label is
the exported agent function's name") is not mechanical here: several of these
are `const captured = guard(...)` inside a helper, not `return guard(...)`
from the exported function, so the implementer has to open each file and find
the exported name. Say that, or the rule will be applied to the enclosing
function name by mistake.

### 9. `lib/runtime/state/messageThread.test.ts` already exists

Task 2 says "create if absent; check first". It exists. Just say "append".
Same for `lib/runtime/runner.test.ts`, which Task 4 already treats correctly.

### 10. Confirm `print` and `color` reach budget.agency

Task 6's snippet calls `print(color.yellow(...))`. `budget.agency` imports
only `formatDuration` from `std::date` (line 23) and `isInteractive` from
`./trace.agency` (line 25). Those two names presumably arrive via the
`std::index` prelude, but the plan should not assume it — add a line to Task 6
telling the implementer to check the build after the edit, or add the import.

### 11. The module docstring goes stale

Task 6 updates `turnBudgetHandler`'s docstring but not the module docstring at
`budget.agency:13-15`, which still says the handler "asks the user whether to
grant more, and either extends the guard in place or stops." After this change
it also rejects foreign trips. Add that edit to the task.

## Smaller notes

### 12. `unansweredToolCalls` is the definition of an invalid *tail*, not an invalid thread

Task 1's doc comment calls it "the single definition of 'invalid thread'". It
only inspects the last assistant message. That is inherited from
`markThreadCancelled` (`threadRepair.ts:46-51`) and it is correct for the
traced failure, because the tool loop only advances past an assistant turn
once its results are in. But an unqualified claim invites someone to reach for
it as a general validity check later. Reword to "the trailing assistant turn's
unanswered calls — the only structurally invalid shape a mid-round stop can
leave."

### 13. Reopen is not the same thing as "a new user turn"

Task 4's comment says "a reopen means the previous turn on this thread stopped
mattering." That is true for the REPL. It is not literally true in general:
if the same run opens the same session from two different step paths, the
second one is a reopen with `isResumption` true and repair will run. Harmless
today, because a healthy in-run thread has no dangling tail. Worth one clause
in the comment so the next reader does not conclude the invariant is stronger
than it is. The spec already flags the adjacent concurrent-branch case (spec
lines 330-339); this is the same family.

### 14. Model the Task 6 fixture on the existing one

`tests/agency/guards/turn-budget-partial.agency` puts `_advanceTime` inside a
called function (`solve`, lines 11-15) rather than directly in the guard body,
and wraps the inner work in its own labelled guard (lines 20-31). Task 6's
fixture calls `_advanceTime(20000)` directly inside the guard block. Guard
trips are checked at step boundaries, so a body with no boundary in it may not
trip where you expect. Copy the working shape.

The `handle { ... } with turnBudgetHandler` form is fine — that named-function
form is what `coordinator.agency:362` uses.

### 15. Say in the body that the end-to-end regression is being dropped

The spec asks for an Agency execution test that parks, abandons, sends a new
message, and asserts no 400 (spec lines 501-504). The plan drops it, with a
sound reason buried in the execution notes at line 1022 (the mock provider
does not enforce the rule, so the assertion would be vacuous). That reasoning
is right, but it belongs in the plan's own testing discussion where a reviewer
comparing spec to plan will find it — not in a footnote after Task 8.

## Sequencing

Tasks 1→5 ordered, 6-7 independent: correct as written. One suggestion — move
Task 7 (labels) before Task 6, so the Task 6 notice has real labels to print
while you are testing it by hand. Nothing depends on the order otherwise.

---

# Anti-pattern audit

Checked every code snippet in the plan against
`packages/agency-lang/docs/dev/anti-patterns.md`.

Short answer to "is it writing declarative interfaces that encapsulate
complexity, or imperative code": **mostly imperative, in three specific
places, and in all three the spec had already asked for the declarative
version.** They are findings A, B and C below. The rest of the catalog is
clean or only lightly touched.

## A. The append loop is duplicated instead of shared

**Anti-patterns hit:** "Duplicating existing code", "Imperative code
everywhere", "Inconsistent patterns".

After Task 1 and Task 3, `threadRepair.ts` contains the same procedure twice:

```ts
// markThreadCancelled (Task 1)              // repairAbandonedTurn (Task 3)
for (const call of unansweredToolCalls(m)) { for (const call of dangling) {
  m.push(smoltalk.toolMessage(TEXT_A, {...}))  m.push(smoltalk.toolMessage(TEXT_C, {...}))
}                                            }
m.push(smoltalk.assistantMessage(TEXT_B))    m.push(smoltalk.assistantMessage(TEXT_D))
```

The plan shares the *scan* (`unansweredToolCalls`) and duplicates the *append*.
The spec explicitly asked for both to be shared — spec line 378-379: "Both
repair functions share `unansweredToolCalls` and the append loop; only the
message text differs."

This is the "what vs how" split the anti-pattern doc is about. The *how*
(stub every unanswered call, then leave a breadcrumb) is one procedure. The
*what* (which words, for which situation) is the thing that differs. Written
declaratively:

```ts
type RepairWording = { perCall: string; breadcrumb: string };

/** Stub every unanswered call on the trailing assistant turn, then leave a
 *  breadcrumb. The only thing that varies between repairs is the wording. */
function appendRepair(
  messages: MessageThread,
  wording: RepairWording,
): DanglingToolCall[] { ... }
```

and then each named repair is a declaration rather than a procedure.

One honest complication, which the plan should address rather than use as a
reason to skip this: the two are not *only* text. They differ in two ways.

- `markThreadCancelled` appends its breadcrumb even when nothing was dangling
  (any assistant turn at all is enough — `threadRepair.ts:52`, preserved by
  the plan's `hasAssistant` check). `repairAbandonedTurn` is a total no-op in
  that case.
- `repairAbandonedTurn` bumps `repairs`.

So the shared piece is the per-call stub loop plus the breadcrumb push; the
two policy differences stay in the two named functions. That is still one
copy of the loop instead of two. Either do that, or write a sentence in the
plan saying why the duplication is preferable — but do not silently drop a
thing the spec asked for.

While you are there: `markThreadCancelled` returns `void` and
`repairAbandonedTurn` returns `DanglingToolCall[]`, for near-identical work.
That is the catalog's `getUser`/`fetchUser` example. Give them the same return
contract. The names have the same problem — `mark...` and `repair...` for two
repairs. `markThreadCancelled` is pre-existing, so renaming is optional, but
the new one should not widen the gap.

## B. `repairs` is a raw public mutable field, so its invariant lives nowhere

**Anti-patterns hit:** "Order-dependent mutable state", "Leaky abstractions".

This is the strongest finding. Task 2 adds `repairs: number = 0` as a plain
public field, and then every rule about it is enforced somewhere else:

- `repairAbandonedTurn` reaches in from another module and does
  `messages.repairs += 1` (plan line 415).
- `adoptFrom` overwrites it wholesale (plan line 293).
- `assertSnapshotNotStale` compares two of them (plan line 683).
- The comparison only works if it runs *before* `adoptFrom` — the ordering I
  flagged as finding 6 above.
- The tests assign it directly (`t.repairs = 2`, `live.repairs = 1`).

The counter is supposed to be monotonic — the whole safety argument rests on
"a repaired thread can never look older than it is" — but nothing enforces
that, because assignment is open to everyone. That is exactly the catalog's
"Order-dependent mutable state" entry: reorder two lines in `prompt.ts` and
the guard silently stops working, with no test failing (see finding 5).

The declarative version puts the invariant on the class that owns the value:

```ts
/** Record that this thread was repaired. Monotonic on purpose — the stale-
 *  checkpoint check reads it as a generation number, so it must only ever
 *  go up. */
markRepaired(): void {
  this.repairs += 1;
}
```

and `repairAbandonedTurn` calls `messages.markRepaired()` instead of doing
arithmetic on someone else's field. Better still, have the staleness question
be asked of the thread rather than computed by a free function that has to
know the field exists:

```ts
/** True when this thread has been repaired since `snapshot` was captured,
 *  which makes restoring `snapshot` a write over newer history. */
isNewerThan(snapshot: MessageThread): boolean {
  return this.repairs > snapshot.repairs;
}
```

`assertSnapshotNotStale` can stay as the thing that throws the user-facing
error, but it should ask that question rather than reach for the number. Then
`prompt.ts` reads as *what* is true ("refuse if the live thread is newer"),
not *how* it is determined.

Note the field's `fromJSON` handling (`let _repairs = 0` alongside the other
locals) is fine as written. That file already does exactly that for
`_summary`, `_hidden`, `_label` (`messageThread.ts:184-190`), and matching the
surrounding file is itself the right call — "Inconsistent patterns" would be
the worse outcome.

## C. The seam does policy the seam should not know about

**Anti-patterns hit:** "Imperative code everywhere", "Leaky abstractions".

Task 4 drops roughly fifteen lines of nested logic plus a fifteen-line comment
into `Runner.thread()`, a method that already runs from `runner.ts:612` to
past `:800`:

```ts
if (isResumption) {
  const reopened = threads.get(tid);
  if (reopened) {
    const repairedCalls = repairAbandonedTurn(reopened);
    if (repairedCalls.length > 0) {
      this.ctx.statelogClient?.threadRepaired?.({
        threadId: `t${tid}`,
        toolCallIds: repairedCalls.map((c) => c.id),
      });
    }
  }
}
```

Three pieces of knowledge leak into the runner here: that a thread might not
be in the registry, that an empty repair should not emit an event, and the
shape and id-slugging of the statelog payload. None of those are the runner's
business — the runner's business is "a reopened thread gets repaired."

The spec said this in as many words (spec line 391-392): "what matters is that
the repair *logic* stays in `threadRepair.ts` and the seam only calls it."

Declarative version — one line at the seam:

```ts
if (isResumption) {
  await repairReopenedThread(threads.get(tid), this.ctx.statelogClient, tid);
}
```

with the null check, the emptiness check, and the event emission inside
`threadRepair.ts`. Two benefits beyond readability: the comment explaining the
resume-safety argument moves next to the code it is defending, and
`repairReopenedThread` becomes unit-testable without constructing a `Runner`,
a `ThreadStore` and a mock ctx — which is most of the ceremony in Task 4's
test.

The `?.` chain itself is fine, incidentally: `runner.ts:792` already does
`this.ctx.statelogClient?.threadEndHookError?.({...})` un-awaited, so the plan
is matching an existing pattern rather than inventing one.

## D. Two smaller imperative spots

**`unansweredToolCalls`'s backwards for-loop.** The plan copies the hand-rolled
reverse scan out of `markThreadCancelled` verbatim:

```ts
let lastAssistant = -1;
for (let i = all.length - 1; i >= 0; i--) {
  if (all[i] instanceof smoltalk.AssistantMessage) { lastAssistant = i; break; }
}
```

`findLastIndex` says the same thing in one line, and it is already used in
this codebase at `lib/runtime/prompt.ts:1246`, so there is no compatibility
question:

```ts
const lastAssistant = all.findLastIndex(
  (m) => m instanceof smoltalk.AssistantMessage,
);
```

Since Task 1 is a refactor that rewrites this code anyway, this is a free
improvement rather than unrelated churn.

**The double scan in the rewritten `markThreadCancelled`.** The plan's version
computes `hasAssistant` with a `.some()` pass, then calls
`unansweredToolCalls`, which immediately scans for the same thing again. The
caller is re-deriving something the helper already knows — a small leak. If
you take finding A's shared `appendRepair`, this disappears; otherwise export
a tiny `hasAssistantTurn(messages)` so there is one definition of the
question.

**`new Set` for the answered ids.** CLAUDE.md says "Use arrays instead of
sets." The existing code uses a `Set` at `threadRepair.ts:55`, and there are 9
other `new Set(` uses under `lib/runtime/`, so this is a carry-over rather
than a new violation. Not worth churn on its own — but since Task 1 is
rewriting the function, decide it consciously and say which way you went.
`answeredIds.includes(call.id)` on an array reads more plainly and these
arrays are a handful of elements.

**The Agency `who` block in Task 6.** Already covered as finding 1 — it is
imperative only because of a constraint that does not exist. `??` works.

## E. Catalog entries that are clean

For completeness, I checked and found nothing on: nested ternaries;
try/catch with a silent catch (no try/catch is added at all); dynamic
imports/requires; `safeDelete` (no deletions); magic numbers (`repairs`
starts at a named default, the wording strings are named constants —
`ABANDONED_CALL_TEXT` / `ABANDONED_TURN_TEXT` is good practice and worth
calling out); nested objects in type definitions (`DanglingToolCall` is flat);
the `...(x ? {x} : {})` spread pattern; one-line `if` statements; overloaded
single lines; and tests whose failure would be catastrophic.

Single-character names appear in the tests (`t`, `c`, `m`), which the catalog
discourages — but `lib/runtime/threadRepair.test.ts:20` onward already uses
`t` throughout, and matching the file beats matching the rule here.

## Summary of what to change

1. Share the append loop between the two repairs (finding A) — the spec asked
   for this.
2. Give `MessageThread` a `markRepaired()` and let it answer the staleness
   question, instead of exposing a bare mutable counter that four other places
   have to handle correctly (finding B). This also fixes the silent-ordering
   hazard from finding 6 above.
3. Move the null check, the emptiness check and the statelog payload out of
   `Runner.thread()` and into `threadRepair.ts`, leaving one call at the seam
   (finding C) — the spec asked for this too.
4. Use `findLastIndex`, drop the double scan, and decide the Set-vs-array
   question deliberately (finding D).

Items 1 and 3 are both places where the plan is *less* declarative than the
spec it is implementing, which is the clearest signal that they are worth
fixing rather than arguing about.

---

# Test plan review

The question I asked of each test: **if the code it covers were wrong, would
this test go red?** For several of them the answer is no.

## First, one claim in the plan that is false

Task 6 Step 4 says running `turn-budget-partial.agency` proves "the handler's
own-label approve/reject flows are untouched" (plan line 857). It does not.

`tests/agency/guards/turn-budget-partial.agency` never uses
`turnBudgetHandler`. It uses a hand-written inline handler that *imitates* it
(lines 40-49 and the matching block in `approveTurn`):

```agency
} with (i) {
  if (i.effect == "std::guard" && i.data.label == "agency-turn") {
    partial = "${i.data.draftValue}"
    return reject()
  }
  return pass()
}
```

I grepped the whole repo: `turnBudgetHandler` appears in exactly one file
outside `lib/agents/agency-agent/` — as a *comment* on line 3 of that same
fixture. **Nothing tests `turnBudgetHandler` today.** So Task 6 is editing an
untested function while believing it has a regression net, and the plan's
verification step would pass no matter how badly the edit went. This needs
fixing before Task 6 is executed, not after.

## Tests that would stay green if the code broke

### 1. Task 4: an implementation that ignores `isResumption` passes all three tests

The `isResumption` guard is the thing standing between "repair reopened
threads" and "repair every thread on every open". None of the three tests can
tell the difference:

- The first `openOnce` in tests 1 and 2 creates an empty thread — no assistant
  message, so `unansweredToolCalls` returns `[]` and nothing happens either
  way.
- Test 3's thread is valid, so again nothing happens either way.

Delete `if (isResumption)` and the suite is green.

There is a real case hiding here that the plan has not considered.
`createSubthread` seeds the child from the parent via `newSubthreadChild`
(`messageThread.ts:145-149`), which clones the parent's messages. So a
subthread opened off a *damaged* parent starts life with a damaged tail, and
`isResumption` is false there, so it will not be repaired. Whether that is
right is a design question the plan should answer — the plan's own stated rule
is "a thread must be valid before new work is appended to it", which argues
for repairing it. Either way it is the one case that makes the guard
falsifiable, so it should be the test.

### 2. Task 4: the statelog event is never asserted, and cannot fail

The plan adds `threadRepaired` and calls it as
`this.ctx.statelogClient?.threadRepaired?.({...})`. The optional call means a
missing or misnamed method is a silent no-op. No test asserts the event fires,
asserts its payload, or asserts it does *not* fire on a healthy reopen.

So the entire observability feature — whose stated justification is "worth
being able to find in a trace later" (spec line 384-385) — can ship
non-functional with everything green. Assert it in test 1 (fires once, with
`toolCallIds: ["b"]` and the slugged `t<id>`) and in test 3 (does not fire).

### 3. Task 5: the check is tested, its wiring is not

Covered as finding 5 above, but it is worth restating in test terms because
two separate failures both stay green:

- Delete the `assertSnapshotNotStale(args.messages, restored)` line from
  `prompt.ts` entirely → suite green.
- Move it one line down, after `args.messages.adoptFrom(restored)` → suite
  green, and the guard is permanently defeated, because `adoptFrom` copies
  `repairs` from the snapshot first (finding B).

A single test at the restore site kills both: live thread at `repairs: 1`,
`self.messagesJSON` snapshot at `0`, run the restore, expect the throw.

### 4. Task 3: monotonicity is untested

Write `messages.repairs = 1` instead of `+= 1` and every test passes. The
staleness design treats this as a generation counter that only goes up, so
"repair twice, expect `repairs === 2`" is worth the one line — especially
since a session can legitimately be abandoned more than once.

### 5. Task 1: the label-preservation claim has no test

The entire justification for switching `markThreadCancelled` from
`setMessages` to `push` is that labels survive (plan line 70), and the plan
goes as far as editing the doc comment in `messageThread.ts:59` to assert it.
Nothing tests it. Revert to `setMessages` and the suite is green.

Add a test that labels a message, repairs, and asserts the label is still on
the right message — and assert `messageLabels.length === messages.length`
afterwards, since `messageThread.ts:55-60` says that alignment "does not
degrade gracefully".

## Missing cases

### 6. The most important missing test: repair must not fire while a resume is pending

This is spec requirement 2 (spec lines 264-269) and the single most dangerous
failure mode in the design — repairing a thread whose turn can still be
resumed leaves two results for one call, which the spec calls "invalid in a
new way, and harder to reason about."

The plan's entire defense is prose plus a code comment. Zero tests.

It is directly testable, and cheaply: reuse the same frame across two
`thread()` calls (rather than a fresh one per call as `openOnce` does), so
`frame.locals["__thread_<path>"]` is already set on the second entry, damage
the thread in between, and assert `repairs` stays 0. That test fails the day
someone removes the frame-locals guard — which is exactly the change the
plan's own comment warns about but does nothing to detect.

### 7. Task 6: nothing checks that non-guard interrupts still pass through

Task 6 splits one early-return condition into two. Getting that wrong means
`turnBudgetHandler` starts rejecting tool-approval interrupts, which would
break the policy handler chain for the whole agent — a much worse outcome
than the bug being fixed. There is no test for it now (see the false claim
above) and the plan adds none.

Add a case to the new fixture: raise a non-`std::guard` interrupt through
`turnBudgetHandler` and assert it reaches an outer handler.

### 8. Task 6: nothing checks the handler's own-label paths

Same root cause. Since `turn-budget-partial.agency` does not exercise
`turnBudgetHandler`, Task 6 should add own-label approve and own-label reject
cases against the real imported handler. The non-interactive reject path
(`budget.agency:149-152`) is the easy one to cover in a test, since
`isInteractive()` is false under the test runner; the interactive prompt path
needs `input()` mocking and may not be worth it — say so explicitly if you
skip it.

### 9. Task 6: the salvage assertion

Covered as finding 3 above. `failure:true` does not demonstrate that "the
caller salvages via finalize or draftValue" — give the inner guard a
`finalize` and assert the partial comes back.

### 10. Small, cheap additions

- **Two dangling calls, not one.** Task 3's test leaves exactly one call
  unanswered, so a body that pushes once instead of looping passes. The
  existing `markThreadCancelled` test at `threadRepair.test.ts:30` uses a
  three-call batch; match it.
- **Trailing assistant with no tool calls at all.** This is the shape of every
  ordinary reply, and after Task 4 it is the hot path on every healthy reopen.
  The `?? []` branch is covered indirectly once the two functions share code
  (`threadRepair.test.ts:20` exercises it through `markThreadCancelled`), but
  `unansweredToolCalls` deserves it directly.
- **Task 1 test 1 does not catch a `slice` bug.** If the `answered` set were
  built from all messages instead of `slice(lastAssistant + 1)`, the test
  still returns `["b"]`. To make it bite, put an *unanswered* call on an
  earlier assistant message and assert it is ignored — that is the function's
  actual documented contract.

### 11. An upgrade-path case nobody has decided on

I confirmed the counter really does reach checkpoints: `snapshotThread` is
`() => messages.toJSON()` at `prompt.ts:1076`, and `toJSON` is where Task 2
adds the field. Good.

But `prompt.ts:1068-1072` notes that older checkpoints hold a bare message
array and revive through `fromJSON`'s legacy branch — where `repairs` will be
0. So a checkpoint taken *before this PR ships*, restored into a thread that
has since been repaired, throws. That is probably the right answer, but it is
a behavior change on the upgrade path that the plan has not noticed. Decide it
and, if you keep it, test it (legacy bare-array snapshot + repaired live
thread → throws with the clear message).

## What the test plan gets right

Not everything is a hole, and some of this is better than typical:

- **Task 2's four tests are tight.** Default, JSON-shape suppression when
  zero, round-trip, and `adoptFrom` — each one goes red if its corresponding
  line is wrong. The shape-suppression test in particular is the kind of thing
  people skip.
- **The byte-identical assertions** (`JSON.stringify(t.toJSON())` before and
  after) in Task 3 and Task 4 are the right shape for "this must not touch
  anything" — much stronger than asserting a couple of fields.
- **The count is accurate.** Task 1 Step 4 says "all four pre-existing
  `markThreadCancelled` tests"; there are exactly four
  (`threadRepair.test.ts:20, 30, 51, 74`), plus one for `needsThreadRepair` at
  `:82`. Those four do genuinely guard the refactor's core behavior.
- **Task 7's verification command is valid** — `tests/agency/agents/expert.agency`
  exists.
- **The honesty about what cannot be tested** (execution note at plan line
  1022: the mock provider does not enforce the tool_result rule, so "no longer
  400s" cannot be asserted end-to-end) is the right call, and correctly
  reasoned. My only complaint is where it is filed — see finding 15 above.

## Priority

If only three things get added, make them:

1. Repair does not fire on a resume (missing case 6) — highest consequence,
   currently defended only by prose.
2. `assertSnapshotNotStale` is actually wired into `prompt.ts` and runs before
   `adoptFrom` (green-when-broken 3) — one test covers both failure modes.
3. Real coverage of `turnBudgetHandler`, including non-guard pass-through
   (missing cases 7 and 8) — because the plan currently believes it has this
   and does not.
