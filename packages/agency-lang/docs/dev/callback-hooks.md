# Callback hooks and interrupts

Agency lets user code register callbacks for runtime events
(`onFunctionStart`, `onNodeStart`, `onLLMCallStart`, `onToolCallStart`,
etc.) via the stdlib `callback()` function. A callback body can call
`interrupt(...)` like any other agency code. This doc explains what
happens to that interrupt and where it ends up.

## Two paths through `callHook`

`callHook(...)` in `lib/runtime/hooks.ts` is the single dispatcher that
fires every callback for a given hook name. It now returns
`Interrupt[] | undefined`:

- **`undefined`** — no callback raised an interrupt; the hook fired and
  every callback completed normally.
- **`Interrupt[]`** — at least one callback halted with an `interrupt`
  statement that wasn't caught by a `handle` block on the live call
  stack. *All* callbacks still ran (interrupts from callback A do not
  short-circuit callback B); the returned array contains every
  interrupt that bubbled out.

There are two kinds of call site:

### Codegen-emitted (`ts.callHook(...)`)

These fire from inside compiled agency code (function entry/exit, node
entry/exit, `emit`). The runner, `__stack`, and `__stateStack` are in
scope at the firing point. After Phase 1, these sites check the return
value of `callHook` and propagate it through the same interrupt-return
mechanism the rest of the runner uses — the user can respond to the
interrupt via `respondToInterrupts` and resume the program.

In Phase 0 (the plumbing PR) these sites still drop the returned
interrupt array because the generated code wraps `await callHook(...)`
in a statement context that discards the value. That preserves the
pre-refactor "fire and forget" behavior. Phase 1 replaces this with a
specialized Runner step type (`runner.hook(id, name, data)`) that
checkpoints + propagates.

### TS-side runtime (`callHookAndDrop(...)`)

These fire from `lib/runtime/node.ts` and `lib/runtime/prompt.ts`,
outside any agency frame. They cannot pause/resume cleanly because
either there's no agency state to checkpoint (`onAgentStart` /
`onAgentEnd`) or the surrounding TS code (`runPrompt`'s internal state
machine) has no substep machinery to skip already-fired hooks on
resume. These sites use `callHookAndDrop` which fires the hook, logs
any returned interrupts to `console.error`, and continues. Phase 2
will migrate the LLM/tool hooks to a proper propagation path by
splitting `runPrompt` into agency-callable pieces.

## Errors vs. interrupts in callback bodies

`fireWithGuard` distinguishes the two:

- A real JS `throw` inside a callback body is caught and
  `console.error`-logged. It never propagates further.
- An `interrupt(...)` statement in a callback body returns
  `Interrupt[]` from `AgencyFunction.invoke`. `invokeCallback` returns
  the array; `fireWithGuard` returns the array; `callHook` collects it
  into its batch. The interrupt does NOT go through the `catch` block.

`RestoreSignal` and `AgencyCancelledError` are special — they always
re-throw, since they're internal control-flow signals the runtime
relies on.

## Multiple callbacks on the same hook

`gatherCallbacks` returns callbacks in this order:
1. Innermost stack-frame scoped callbacks
2. Outer stack-frame scoped callbacks (walking up)
3. Top-level callbacks (registered at module init), in registration order
4. The TS-passed `ctx.callbacks[name]` callback, if any

`callHook` invokes them in that order and collects interrupts as it
goes. The returned `Interrupt[]` preserves the firing order.

## Why the batch-and-return shape

This mirrors `runForkAll` / `runRace` from
`docs/dev/concurrent-interrupts.md`. Callbacks are sequential rather
than parallel, but the invariant is the same: each callback runs to
completion regardless of what its siblings did, and the caller gets
every halt batched together so the user can respond to all of them in
one cycle of `respondToInterrupts`.
