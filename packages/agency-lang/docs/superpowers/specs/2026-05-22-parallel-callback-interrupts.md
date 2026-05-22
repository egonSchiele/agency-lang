# Spec: Callback Interrupts Across Parallel Tool Calls

## Problem

`runPrompt` runs multiple tool calls from a single LLM round through
`PromptRunner.parallel(...)`. Each parallel branch independently fires
the `onToolCallStart` / `onToolCallEnd` hooks for its tool.

When a top-level callback registered on one of those hooks throws
`interrupt(...)`, today only the first branch's interrupt surfaces.
Interrupts from the other branches are dropped (or never observed),
because the per-branch hook fire is a plain `await callHook(...)` inside
the branch closure, not a runner step. It does not produce a checkpoint
the parallel runner can coordinate across siblings, and there's no
resume point for the other branches' callbacks.

Concretely:
- A single callback on a single hook in a single branch already works
  (Phase 1).
- Multiple callbacks on the same hook in the same sequential call site
  already works — `callHook` batches them (`hooks.ts` `callHook`).
- Multiple callbacks on the same hook fired from **different parallel
  branches at the same time** does not work. This is the gap.

A regression test exercising this case was written and skipped during
the Phase 1 PR.

## Constraints

- Must not regress sequential `callHook` batching.
- Must not regress single-branch callback interrupts.
- Handlers (`handle` blocks) still must fire correctly for any
  callback interrupt that is caught.
- Checkpoint state must capture enough per-branch context that resume
  re-invokes the right callback bodies with the right interrupt
  responses, and reads each callback's response from its own `__self`
  frame.

## Rough Solution

Reuse the existing `runForkAll` / `PromptRunner.parallel` concurrent-
interrupt machinery rather than building new cross-branch plumbing. The
hook fire inside each branch needs to participate in that machinery as
a first-class step.

Sketch:

1. **Promote the per-branch hook fire to a runner step.** Inside each
   branch of `pr.parallel(...)`, wrap the `callHook("onToolCallEnd",
   ...)` call (and `onToolCallStart`) as its own `b.step(...)` rather
   than a bare `await`. The step's body calls `callHook`; if the result
   is a non-empty `Interrupt[]`, the step yields those interrupts up to
   the branch, exactly the way an unhandled callback interrupt yields
   today in the single-branch Phase 1 codegen.

2. **Let `pr.parallel` collect across branches before pausing.** The
   parallel runner already supports "every sibling runs to completion
   or to its next interrupt; batch all interrupts together at the end"
   for tool **bodies** (see `docs/dev/concurrent-interrupts.md`). Reuse
   that. If it currently short-circuits on the first interrupting
   branch, generalize it to wait for siblings — the same shape of
   change `callHook` already received.

3. **Checkpoint per branch.** The step in (1) must record into the
   branch's checkpoint:
   - which hook fired
   - the `interruptIds[]` returned by that fire
   - enough locals to re-enter the correct callback frames on resume

   The interrupt id → response mapping already lives on the runtime
   context (`_interruptResponses` keyed by interrupt id), and each
   lifted callback already reads its own response from
   `__self.__interruptId_*`. No changes needed there.

4. **Resume.** On resume, `pr.parallel` restores each branch's
   checkpoint as it does today for parallel tool bodies. Each branch
   re-enters its hook step, `callHook` re-invokes the lifted
   callbacks, and each callback reads its response from
   `__ctx.getInterruptResponse(__self.__interruptId_*)`. Branches that
   had no interrupt skip the step on resume and continue.

5. **Tests.** Restore the skipped mixed-parallel-tools fixture as the
   primary regression test. Add at least:
   - two parallel tools, each with one top-level `onToolCallEnd`
     callback that interrupts — both interrupts must surface, resume
     must feed responses to the correct branch.
   - two parallel tools, one with an interrupting callback and one
     without — only the interrupting branch should pause and resume.
   - two parallel tools, both with multiple top-level callbacks on the
     same hook, multiple of which interrupt — combines sequential
     `callHook` batching with parallel branch batching.

## Out of Scope

- Cross-prompt or cross-`runPrompt` concurrency (multiple prompts in
  flight simultaneously).
- `onAgentStart` / `onAgentEnd` interrupts — these fire outside any
  agency frame and stay log+drop.
- Any change to handler semantics. Handlers continue to catch
  callback interrupts the same way they do in the single-branch case.

## Estimated Effort

~1–2 days, mostly small plumbing, *if* `pr.parallel`'s concurrent-
interrupt path already supports "let every branch run to its next
interrupt before pausing." If it currently short-circuits on the first
interrupt, add a day or so to generalize that first. Risk is mostly in
step (2): need to confirm the existing parallel runner behavior before
committing to the estimate.
