# Plan review: resumable guards, rev 5 (2026-07-16)

**Reviewing:** `docs/superpowers/plans/2026-07-16-resumable-guards.md` (rev 5)
**Supersedes:** the rev-4 review.
**Verdict:** The two key designs are right this time. I tried to break the trip
key and could not — it is genuinely sound, and decision 14 is the right law to
have written down. The handler memo design is also right *in every respect except
where it is installed*: **`withPushedHandler` is not the path Agency `handle`
blocks take.** They go through `Runner.handle`, which calls `ctx.pushHandler`
directly. As written, Task 1.3 would capture `liveGuardIds` for TypeScript-
installed handlers only, and decision 3 would not apply to the construct the
plan's own walked example uses.

That is one blocker, and the fix is small and makes the design better: the right
anchor has everything 1.3b asks for and is two lines from where the plan already
points. Everything else below is a note.

All line references are `packages/agency-lang/`, verified today.

---

# Blocking

## 1. Agency `handle` blocks never reach `withPushedHandler`

Task 1.3a says capture happens in `withPushedHandler` (`asyncContext.ts:143`),
"the one place that has both the context AND the ALS-resolved stack." That
function has exactly two callers, and both are TypeScript-side:

- `agency.ts:304` — `agency.withHandler(handler, fn)`, the public TS API.
- `agencyFunction.ts:267` — the auto-approve handler `preapprove()` wraps around
  each call.

Agency's own `handle ... with` compiles somewhere else entirely:

```
handleBlock  →  processHandleBlockWithSteps      (typescriptBuilder.ts:4020-4053)
             →  ts.runnerHandle({id, handler, body})
             →  "await runner.handle(<id>, <handler>, async (runner) => {...})"
                                                       (prettyPrint.ts:370)
             →  Runner.handle(...)                     (runner.ts:766)
                  this.ctx.pushHandler(handlerFn);     (runner.ts:778)
```

`with` modifiers take the same path (`processWithModifier`, :4055). And there is
a third registration path the plan does not mention: the `withHandler` TSIR node
(`prettyPrint.ts:389`) emits `getRuntimeContext().ctx.pushHandler(...)` inline
for top-level static/global init wrappers.

So under Task 1.3 as written, the walked example in Part 2 —

```
handle { guard(label: "coder", cost: $1.00) as { ... } } with (intr) { ... }
```

— registers via `Runner.handle`, never touches `withPushedHandler`, and gets no
`liveGuardIds`. The handler cannot be scoped, cannot be budget-isolated, and
`guardsHiddenFrom` has nothing to filter on. The entire feature would work only
for handlers installed from TypeScript.

**The fix is a better anchor, not a bigger one.** `Runner.handle` has everything
1.3b wants, and more legitimately than `withPushedHandler` does:

| 1.3b needs | `Runner.handle` has |
|---|---|
| the branch's guards | `this.stack` — no ALS reach-through |
| a per-frame store (what makes recursion safe) | `this.frame` |
| a position key | `this.stepPath(id)` — already called two lines up, at :776, for coverage |
| a pop point for the delete rule | the existing `finally` at :783-785 |

So 1.3b's sketch becomes, at `runner.ts:778`:

```ts
const memoKey = `__handlerGuards_${this.stepPath(id)}`;
let liveGuardIds = this.frame.locals[memoKey] as string[] | undefined;
if (liveGuardIds === undefined) {
  liveGuardIds = this.stack.guards.map((g) => g.guardId);   // first write wins
  this.frame.locals[memoKey] = liveGuardIds;
}
this.ctx.pushHandler(handlerFn, liveGuardIds);
this.path.push(id);
try {
  await this.runInScope(() => callback(this));
} finally {
  this.path.pop();
  this.ctx.popHandler();
  delete this.frame.locals[memoKey];      // the delete-on-pop rule
}
```

The `activeCallsite()` / `activeFrame()` helpers in the current sketch disappear;
the plan's reasoning about *why* (position key, frame-local store, delete on pop)
is unchanged and still correct.

**Two consequences to write into the task:**

- **The entry-shape change touches all three `pushHandler` callers**, not one.
  Decide what the other two capture rather than letting a default decide.
  Empty-set is not neutral: `guardsHiddenFrom` = "every guard whose id is not in
  the set," so `liveGuardIds: []` means *hide everything*. For the top-level init
  wrapper that is correct (it registers before any guard exists). For
  `preapprove()`'s auto-approve it is harmless in practice (its body is
  `async () => approve()` — nothing to meter) but it should be a stated decision,
  because "harmless because the body happens to be trivial" is exactly the kind
  of thing a later change invalidates silently.
- **`agency.withHandler` is a public TS API** and its handlers are equal
  participants in the same chain (`agencyInterrupt.ts:24-31` says so
  explicitly). It has a stack via ALS but no step id, so it needs its own key
  rule — probably content-derived from the ids themselves, or an explicit
  "TS-installed handlers capture at call time and do not memoize, because they
  are not replayed." Either is fine; silence is not.

## 1b. A gift for Part 1.3: the proof is a line of code, not a doc quote

`Runner.handle` opens with:

```ts
if (this.getCounter() > id) return;      // runner.ts:772
```

That is decision 14's entire justification, sitting in the function this task
edits: **a completed `handle` block does not re-register on replay — it returns
before `pushHandler`.** Every counter design died on exactly this line. Part 1.3
currently cites `docs/dev/interrupts.md`; cite this too. It converts "replay
skips completed work" from something a reader takes on faith into something they
can see, in the code they are about to change.

It also sharpens Part 1.3's own wording: "handlers are re-registered by
re-executing the code that registered them" is true only for blocks still *open*
at checkpoint time. Completed ones are skipped, and correctly so — their scope is
over.

---

# Notes

## 2. The trip key is sound. I tried to break it.

Recording the walk, because it is the kind of thing a future reader will want to
re-derive and the plan's comment covers only two of the five cases:

- **Stable while the trip is open** — nothing in `scopeIds`, `dimension`, or
  `currentLimit()` changes until the answer is applied. Replay re-derives the
  same key and finds the recorded answer. ✅
- **Distinct after an approve** — decision 8 forces the tripped dimension's limit
  strictly above `spent`, and `spent` only grows, so limits strictly increase.
  `@1.00` → `@1.50` → `@1.75`. Never a collision. ✅
- **A clamped negative delta cannot produce a stale key** — clamping to zero
  leaves the dimension over budget and armed, so decision 8 errors rather than
  proceeding with an unchanged key. ✅
- **Disarm leaves the limit unchanged**, so the key would repeat — but a disarmed
  dimension never trips again, so there is no next trip to collide with. ✅
- **The other dimension tripping later** differs in `#dimension`. ✅

One case is load-bearing and unstated, worth a sentence because it looks like a
bug until you see it: **after an approve, a later replay re-reaching the raise
site does not re-raise — not because the key matches, but because the guard is no
longer over budget, so `detectTrippedGuard` returns null and nothing raises at
all.** Without that, a reader asks "what about the next replay?" and the answer
is not in the comment.

## 3. Where does the persisted trip id live?

Rev 4 said `stack.other`; rev 5's sketch passes `key` into `raiseRuntimeInterrupt`
and never says where the id is stored. `agency.interrupt` stores its id in
`frame.locals` (`agencyInterrupt.ts:158`), which is right for a *callsite*-keyed
id but wrong here: the raise happens inside `runPrompt`, whose active frame is
not obviously the trip's owner. Since the key is now globally unique per
(scope, dimension, limit), `stack.other` is the correct store — branch-local,
survives frame pops, no frame scoping needed. Say so; the factored dance now
takes a key AND needs to know which store to use, and that is a new parameter
neither caller has today.

## 4. The memo's survival depends on the checkpoint being a copy

1.3b's third bullet argues the ordering: the snapshot exists before the unwind's
`finally` deletes the entry. That is right. But the property that actually
matters is that `checkpoints.create` **snapshots** `frame.locals` rather than
aliasing it — if it held a live reference, the delete would reach into the
snapshot and the memo would vanish exactly when it is needed.

This is #551's lesson stated in reverse ("the serialize path hides the bug; only
live reuse breaks"), so the odds are good it is already a deep clone. One line to
verify, and worth an explicit sentence in the plan, because the whole delete-on-pop
rule rests on it.

## 5. `ctx.handlers` is context-wide; `liveGuardIds` are branch-local

Handlers live on the RuntimeContext (`context.ts:85`), not the stack. Guards live
on the stack. So a handler registered *inside* fork branch A sits on the shared
handler stack and will be consulted for an interrupt raised in sibling branch B —
at which point `guardsHiddenFrom(entry)` compares A's captured ids against B's
`stack.guards`. Because time clones carry the parent's `guardId` and cost guards
are shared objects, the overlap is partial and the resulting hidden set is
arbitrary rather than meaningfully wrong-or-right.

This is pre-existing strangeness (a branch-registered handler being globally
visible predates this plan), but decision 3 is the first rule that gives it
teeth. Worth one sentence deciding what it means and one fixture pinning it: a
handler registered inside one fork branch, an interrupt raised in its sibling.

## 6. Where does the dedupe wait?

Decision 10 and Task 2.2 say a branch detecting the same over-budget guard
"awaits `settled`." The detection site is synchronous (`detectTrippedGuard():
Guard | null`, and `enforceGuards` is sync today), so the await has to live at
the async raise site. It is implied by `raiseGuardTrip` being `async`, but say
it — the sketch shows the pending record and never shows the wait.

## 7. Small

- The fixture table still calls the headline fixture's mechanism "fresh
  generation." The generation is gone; it is a fresh derived key now. One word.
- Task 3.3's `grantedMs` rule is self-consistent in a way worth stating, since it
  looks arbitrary: the longest branch is necessarily a granted branch (a clone
  without a grant would have tripped at its own limit rather than running past
  it), so "the charged branch's grant" is never zero when it matters.

---

# What is right

Decision 14 is the most valuable thing in this document. It is written as a law
with the failure history attached, which is what will stop the fifth counter from
being invented in six months. Decision 16 is argued the way a decision should be
— three independent reasons, one of which ("an ancestor rule would need a root
carve-out; one rule becoming two is the tell") is a genuinely good piece of
design taste, and it ends with the UX consequence spelled out rather than
discovered later.

The taxonomy now has all four cost sites with the IPC one honestly marked as a v1
limitation and given its own fixture, rather than quietly omitted. The dedupe
section says plainly that the restore path gives a weaker guarantee and names
what bounds it — that is the fix I asked for, and it is better than the
"correct-by-reconstruction" framing it replaces because it tells the truth about
the trade.

And the signal-freshness contract is now structural rather than a standing audit:
"there is no way to hold the stale signal AND be alive" is exactly the argument
that makes the grep unnecessary.

# Recommended next steps

1. Move the capture to `Runner.handle:778`, and decide the rule for the other two
   `pushHandler` callers (blocker 1).
2. Cite `runner.ts:772` in Part 1.3 as decision 14's proof (1b).
3. State where the trip id is stored (note 3), that the checkpoint copies frame
   locals (note 4), and where the dedupe waits (note 6).
4. Decide the cross-branch handler-visibility question and pin it (note 5).
5. Then execute. Nothing else in this plan is unresolved.
