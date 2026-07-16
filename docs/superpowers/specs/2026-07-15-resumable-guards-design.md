# Design: resumable guards — trips as interrupts

**Date:** 2026-07-15
**Status:** Brainstorm complete, owner-agreed. Follow-up to `2026-07-15-save-draft-carry-on-abort-redesign.md` (which ships first and is unchanged by this design).
**Related:** `docs/site/guide/handlers.md` (the rules of handlers), `docs/dev/interrupts.md`, `docs/dev/concurrent-interrupts.md`, and the independent investigation `2026-07-15-guards-as-interrupts-investigation.md` (same conclusion from the code side; its mechanics are folded into the planning notes below).

**Prior art.** Guards were FIRST designed as interrupts (`2026-05-05-guards-design.md`), then deliberately switched to a thrown error (`2026-05-20-cost-and-guard-tracking-design.md`) because "interrupts require serializing execution state, which is complex; users usually want just-stop." Both halves of that rationale are now obsolete: checkpoints are cheap and automatic, and trips already surface at runner step boundaries (`Runner.shouldSkip()`, `runner.ts` ~L315) — the exact granularity interrupts pause and resume at. This design is an informed reversal, not a rediscovery. One difference from the investigation's sketch: it proposed an opt-in `ask:` flag per guard, with un-asked guards keeping today's behavior. The self-answer default below supersedes the flag — an unhandled trip interrupt behaves exactly like today's trip, so backward compatibility needs no new syntax, and a handler can wrap ANY guard (including one in third-party code) without the guard author opting in.

## What we are solving

Today a guard trip is final. When the budget runs out, that code path has ended; `saveDraft`/`finalize` let it return a partial value, but nothing can say "keep going anyway." Three things are inexpressible:

- **A warning guard.** Two guards, five and ten minutes. At five minutes the user wants to tell the LLM "start packing up your work" and continue. At ten minutes they want a hard stop.
- **A check-in.** Run an agent for five minutes, then look at what it has done, then decide: more budget or stop.
- **A reviewer redirect.** A coding agent runs under a budget. When it trips, a reviewer agent examines the work so far and either sends the coder feedback and lets it continue, or kills the attempt and gets the partial back.

The missing capability is a decision point at the trip. Agency already owns the hard part: interrupts can pause a running computation anywhere, serialize it, and resume it. This design routes guard trips through that machinery.

## The model

A guard trip raises an **interrupt** instead of throwing an abort. The branch pauses in place — every frame alive, nothing unwound. Handlers then decide, under the normal rules of handlers:

- **`approve({ maxCost?, maxTime?, message? })`** — continue. Execution resumes exactly where it paused, with fresh budget allowances.
- **`reject()`** — the trip stands. The runtime delivers the guard abort **at the paused point**, and the entire carry-on-abort machinery runs from there: the four-rung level rule, finalizes, the carried draft, the guard's conversion to `success(draft)` or failure. Nothing in that pipeline changes.
- **`propagate()`** — send the decision to the user. This makes interactive check-ins ("your agent has run 5 minutes — grant more?") expressible with existing vocabulary.
- **No handler answers:** the interrupt answers itself as a reject. A headless run never hangs on a trip. This is the one way trip interrupts differ from ordinary interrupts, which surface to the user endpoint when unhandled.

Reject-precedence is unchanged: any handler rejecting rejects. The headline is not that budgets get softer — it is that guards become **resumable**.

**Root budgets stay hard.** `--max-cost`/`--max-time` (#550) are the operator's ceiling. Root trips do not raise interrupts; they keep today's abort path. User code cannot approve its way past them.

## The interrupt shape

- **`effect`**: `std::guard`.
- **`message`**: human-readable, includes the label: `Guard "coder" exceeded its time budget: 5m elapsed (limit 5m)`.
- **`data`**:

```
label: string;                 // user-set via guard(label: "...");
                               // defaults to the guard's source location
dimension: "cost" | "time";    // which budget tripped
limit: number;                 // that dimension's budget
spent: number;                 // what was actually spent
maxCost?: number;              // the guard's configured budgets, for context
maxTime?: number;
draftValue?: any;              // preview — see below
thread?: MessageThread;        // the interrupted conversation — see below
```

**Labels.** `guard(label: "coder", time: 5m)`. The label is how a handler tells guards apart, and it also improves statelog events and failure messages, which today only carry an internal guardId.

**`draftValue` is a preview, not the salvage.** At raise time no unwind has happened, so the value the guard would return does not exist yet — the level rule computes it during the unwind, and finalizes must not run speculatively for a trip that might be approved (they are one-shot death rites). The preview is the guarded block's own `savedDraft` as of the pause: cheap to read, correctly typed for the guard. The authoritative salvage comes from rejecting.

**`thread` is live in-process only.** A handler (e.g. a reviewer agent) can read the interrupted conversation through it. When the interrupt crosses a process boundary (subprocess IPC, user endpoint), the field is dropped — the thread lives in the process that owns it.

## The approve payload

```
approve({ maxCost?: number, maxTime?: number, message?: string })
```

- **Fresh allowance, not a new ceiling.** `maxTime: 5m` means "run 5 more minutes from the resume point"; `maxCost: 0.05` means "spend $0.05 more." An absolute-ceiling reading has a footgun — a new ceiling below what is already spent re-trips instantly.
- **An omitted dimension is disarmed.** `approve({maxTime: 5m})` on a cost+time guard disarms the cost budget and grants five more minutes. `approve({})` disarms the guard entirely.
- **Recurring check-ins fall out for free.** A handler that always answers `approve({maxTime: 5m})` turns one guard into a check-in every five minutes.
- **`message`** is delivered to the paused agent — next section.

Reject takes no payload: the code is dying, and the salvage path already defines what comes back.

## Message delivery

The approve message becomes a **user-role message in the paused conversation**. Mechanics: the message goes into a branch-local pending queue; when the paused LLM tool loop resumes, it drains the queue into the thread before sending the next model request. The model's next turn sees, in order: its prior message, any pending tool results, then the injected message — exactly like a human interjecting. If the pause was not inside an LLM loop, the message waits in the queue and lands on the branch's next `llm()` call.

This reuses the reply-attachments pattern (`docs/dev/reply-attachments.md`): branch-local queue, harvested in the tool loop before the request. The injection point exists today.

## Delivery mechanics of the trip itself

Agency aborts are already cooperative — checked at step boundaries — and that is what makes this design tractable.

- **Cost trips** are detected at charge boundaries, after a call completes. No in-flight work needs interrupting: the runner sees the pending trip at the next step boundary and raises the interrupt there.
- **Time trips** currently cancel an in-flight leaf op via the abort signal. Under this design the timer marks the trip pending and cancels the in-flight LLM request, and the interrupt is raised at that point. On approve, "resume" means **re-issue from the last message boundary**: the thread state is intact, so the loop re-sends the request. This is the same shape as resuming after a tool-raised interrupt, one step coarser — the honest caveat is that the cancelled generation's partial output is gone, and the retry costs a fresh request.
- **Fork branches.** Per-branch semantics are unchanged from #549: a branch's guard clone trips that branch only, and each branch raises its own interrupt. Multiple branches interrupting concurrently is already handled (`docs/dev/concurrent-interrupts.md`). A shared cost guard over budget trips each branch at that branch's next charge boundary.
- **Reject = abort at the pause point.** The continuation resumes just far enough to throw the guard abort exactly where execution stopped. From there the carry-on-abort spec governs, unmodified.

## Walked example: the reviewer redirect

```
node main() {
  handle {
    const result = guard(label: "coder", time: 5m) as {
      return codingAgent(task)
    }
    return result
  } with (intr) {
    if (intr.effect == "std::guard" && intr.data.label == "coder") {
      const review = reviewerAgent(intr.data.draftValue)
      if (review.verdict == "promising") {
        return approve({ maxTime: 5m, message: review.feedback })
      }
      return reject()
    }
    return propagate()
  }
}
```

The handler runs while the coder is frozen. The reviewer examines the draft preview, the thread, or the files on disk. Approve resumes the same conversation with the feedback injected as a user message. Reject kills the attempt and the guard returns the salvaged draft — and the enclosing code can start a fresh attempt with the reviewer's feedback as an argument. Redirect-in-place keeps the context; reject-and-retry gets a clean one. Both compose from the same primitives.

## What this does NOT change

- The salvage machinery (carry-on-abort spec) is untouched. Approve means the partials are unused; reject means the standard unwind produces them.
- `finalize` stays as designed. A handler runs where it is registered and cannot see intermediate frames' locals; finalize remains the per-level translation hook.
- Ordinary interrupts, `saveDraft`, and the handler rules are unchanged. The only new interrupt behavior is the self-answering default, scoped to `std::guard` interrupts.

## Suggested increments (each its own spec-review → plan → PR loop)

1. **Guard labels.** `guard(label:)`, label in `guardTrip` cause, statelog, and failure messages. Small, standalone, useful immediately.
2. **Cost trips as interrupts.** The self-answer default, `reject`/`propagate`, `approve` with fresh allowances and disarm. Cost first because delivery is already cooperative — no cancellation work.
3. **Time trips as interrupts.** Pending-trip flag, cancel-then-pause, resume-as-retry from the last message boundary.
4. **The feedback channel.** `message` in approve + the pending-injection queue; `thread` and `draftValue` in interrupt data.

## To confirm during planning

Several of these are pre-answered by the investigation doc; verify rather than re-derive.

- **The raise site is `Runner.shouldSkip()`** (`runner.ts` ~L315), where trips already surface at step boundaries — raise the interrupt there and the interrupt engine does the rest (the investigation's "Option A"). Do NOT catch-and-restore at `__tryCall`: by then the stack has already unwound.
- **Fresh allowances mutate the guard by its serialized `guardId`** (already on the interrupt data via the trip cause). On approve, look up the live guard and extend it. Neither mutator exists today: `CostGuard` needs a raise-limit method, and `TimeGuard` needs an extend that also resets its tripped/consumed latch — without the latch reset, resume re-trips instantly.
- **The concentrated risk is fork/race clones + IPC**: branch clones carry the PARENT's guardId (`guard.ts` cloneForBranch), so approve-by-guardId must resolve to the right clone; and trip interrupts forwarded across the subprocess boundary need the guard lookup to happen in the process that owns the guard.
- How the self-answer default is represented (a default-disposition field on the interrupt that the user-endpoint surfacing step consults).
- The exact resume-at-pause-point plumbing for reject (deliver the abort as the resumed step's result vs. throw at the continuation's first step).
- Whether `approve` payload validation belongs in the checker (payload keys against the guard's dimensions) or stays runtime-only in v1.
- Rough size from the investigation: true approve-resume is a focused week, not a multi-week rewrite.
